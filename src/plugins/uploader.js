"use strict";

const Helper = require("../helper");
const busboy = require("busboy");
const {v4: uuidv4} = require("uuid");
const path = require("path");
const fsextra = require("fs-extra");
const fs = require("fs");
const fileType = require("file-type");
const readChunk = require("read-chunk");
const crypto = require("crypto");
const isUtf8 = require("is-utf8");
const log = require("../log");
const S3 = require("aws-sdk/clients/s3");

const whitelist = [
	"application/ogg",
	"audio/midi",
	"audio/mpeg",
	"audio/ogg",
	"audio/vnd.wave",
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
	"text/plain",
	"video/mp4",
	"video/ogg",
	"video/webm",
];

const uploadTokens = new Map();

class Uploader {
	constructor(socket) {
		socket.on("upload:auth", () => {
			const token = uuidv4();

			uploadTokens.set(token, true);

			socket.emit("upload:auth", token);

			// Invalidate the token in one minute
			setTimeout(() => uploadTokens.delete(token), 60 * 1000);
		});
	}

	static isValidType(mimeType) {
		return whitelist.includes(mimeType);
	}

	static router(express) {
		express.get("/uploads/:name/:slug*?", Uploader.routeGetFile);
		express.post("/uploads/new/:token", Uploader.routeUploadFile);
	}

	static async routeGetFile(req, res) {
		const name = req.params.name;
		const blobFolder = name.substring(0, 2);
		const blobFile = `uploads/${blobFolder}/${name}`;
		let mimeType;
		let fileBody;

		//upload in s3
		const s3 = new S3({
			endpoint: Helper.config.s3.endpoint,
			accessKeyId: Helper.config.s3.accessKeyId,
			secretAccessKey: Helper.config.s3.secretAccessKey,
		});
		var params = {
			Bucket: Helper.config.s3.bucket,
			Key: blobFile,
		};
		s3.getObject(params, (err, data) => {
			if (err) {
				return res.status(500);
			}

			mimeType = data.ContentType;
			fileBody = data.Body;

			// doesn't exist
			if (mimeType === "") {
				return res.status(404).send("Not found");
			}
			// Force a download in the browser if it's not a whitelisted type (binary or otherwise unknown)
			const contentDisposition = Uploader.isValidType(mimeType) ? "inline" : "attachment";
			if (mimeType === "audio/vnd.wave") {
				// Send a more common mime type for wave audio files
				// so that browsers can play them correctly
				mimeType = "audio/wav";
			}
			res.setHeader("Content-Disposition", contentDisposition);
			res.setHeader("Cache-Control", "max-age=86400");
			res.contentType(mimeType);

			res.send(fileBody);
		});
	}

	static routeUploadFile(req, res) {
		let busboyInstance;
		let uploadUrl;
		let blobDest;

		const doneCallback = () => {
			// detach the stream and drain any remaining data
			if (busboyInstance) {
				req.unpipe(busboyInstance);
				req.on("readable", req.read.bind(req));

				busboyInstance.removeAllListeners();
				busboyInstance = null;
			}
		};

		const abortWithError = (err) => {
			doneCallback();

			return res.status(400).json({error: err.message});
		};

		// if the authentication token is incorrect, bail out
		if (uploadTokens.delete(req.params.token) !== true) {
			return abortWithError(Error("Invalid upload token"));
		}

		// if the request does not contain any body data, bail out
		if (req.headers["content-length"] < 1) {
			return abortWithError(Error("Length Required"));
		}

		// Only allow multipart, as busboy can throw an error on unsupported types
		if (!req.headers["content-type"].startsWith("multipart/form-data")) {
			return abortWithError(Error("Unsupported Content Type"));
		}

		// create a new busboy processor, it is wrapped in try/catch
		// because it can throw on malformed headers
		try {
			busboyInstance = new busboy({
				headers: req.headers,
				limits: {
					files: 1, // only allow one file per upload
					fileSize: Uploader.getMaxFileSize(),
				},
			});
		} catch (err) {
			return abortWithError(err);
		}

		// Any error or limit from busboy will abort the upload with an error
		busboyInstance.on("error", abortWithError);
		busboyInstance.on("partsLimit", () => abortWithError(Error("Parts limit reached")));
		busboyInstance.on("filesLimit", () => abortWithError(Error("Files limit reached")));
		busboyInstance.on("fieldsLimit", () => abortWithError(Error("Fields limit reached")));

		busboyInstance.on("file", (fieldname, fileStream, filename, encoding, mimetype) => {
			let uuid = uuidv4();
			blobDest = uuid.substring(0, 2);
			blobDest = `uploads/${blobDest}/${uuid}`;
			uploadUrl = `uploads/${uuid}/${encodeURIComponent(filename)}`;

			//upload in s3
			const s3 = new S3({
				endpoint: Helper.config.s3.endpoint,
				accessKeyId: Helper.config.s3.accessKeyId,
				secretAccessKey: Helper.config.s3.secretAccessKey,
			});

			var params = {
				ContentType: mimetype,
				Bucket: Helper.config.s3.bucket,
				Key: blobDest,
				Body: fileStream,
			};
			s3.upload(params, function(err, data) {
				if (err) {
					abortWithError(err);
				}
			});
		});

		busboyInstance.on("finish", () => {
			doneCallback();

			if (!uploadUrl) {
				return res.status(400).json({error: "Missing file"});
			}

			// upload was done, send the generated file url to the client
			res.status(200).json({
				url: uploadUrl,
			});
		});

		// pipe request body to busboy for processing
		return req.pipe(busboyInstance);
	}

	static getMaxFileSize() {
		const configOption = Helper.config.fileUpload.maxFileSize;

		// Busboy uses Infinity to allow unlimited file size
		if (configOption < 1) {
			return Infinity;
		}

		// maxFileSize is in bytes, but config option is passed in as KB
		return configOption * 1024;
	}

	// Returns null if an error occurred (e.g. file not found)
	// Returns a string with the type otherwise
	static async getFileType(filePath) {
		try {
			const buffer = await readChunk(filePath, 0, 5120);

			// returns {ext, mime} if found, null if not.
			const file = await fileType.fromBuffer(buffer);

			// if a file type was detected correctly, return it
			if (file) {
				return file.mime;
			}

			// if the buffer is a valid UTF-8 buffer, use text/plain
			if (isUtf8(buffer)) {
				return "text/plain";
			}

			// otherwise assume it's random binary data
			return "application/octet-stream";
		} catch (e) {
			if (e.code !== "ENOENT") {
				log.warn(`Failed to read ${filePath}: ${e.message}`);
			}
		}

		return null;
	}
}

module.exports = Uploader;
