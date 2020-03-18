"use strict";

const log = require("./log");
const crypto = require("crypto");
const path = require("path");
const Client = require("./client");
const WebPush = require("./plugins/webpush");
const mysql = require("mysql");

module.exports = ClientManager;

function ClientManager() {
	this.clients = [];
}

const schema = [
	// Schema version #1
	"CREATE TABLE IF NOT EXISTS users (username VARCHAR(255), config TEXT, CONSTRAINT name_unique UNIQUE (username)) collate utf8mb4_unicode_ci;",
	"CREATE INDEX IF NOT EXISTS username ON users (username)",
];

ClientManager.prototype.initDB = function(identHandler, sockets) {
	this.database = mysql.createPool({
		connectionLimit: 100,
		host: "localhost",
		user: "root",
		password: "secret",
		database: "thelounge",
		charset: "utf8mb4_unicode_ci",
	});
};

ClientManager.prototype.init = function(identHandler, sockets) {
	this.initDB();
	schema.forEach((line) => {
		this.database.query(line, function(error) {
			if (error) {
				log.error(line, error);
				throw error;
			}
		});
	});

	this.sockets = sockets;
	this.identHandler = identHandler;
	this.webPush = new WebPush();

	this.database.query("SELECT * FROM users", (err, rows) => {
		if (err) {
			log.error(err);
			return;
		}

		rows.forEach((row) => {
			const config = JSON.parse(row.config);
			log.info(typeof config);
			this.clients.push(new Client(this, row.username, config));
		});
	});
	// LOAD USERS
};

ClientManager.prototype.findClient = function(name) {
	return this.loadUser(name);
};

ClientManager.prototype.loadUser = function(name) {
	let client = this.clients.find((u) => u.name === name);

	if (!client) {
		this.database.query("SELECT * FROM users WHERE username = ?", [name], (err, rows) => {
			if (err) {
				log.error(err);
				return;
			}

			rows.forEach((row) => {
				const config = JSON.parse(row.config);
				client = new Client(this, row.username, config);
				this.clients.push(client);
			});
		});
	}

	return client;
};

ClientManager.prototype.getUsers = function() {
	return this.clients.map((u) => u.name);
};

ClientManager.prototype.addUser = function(name, password, enableLog) {
	this.initDB();

	if (path.basename(name) !== name) {
		throw new Error(`${name} is an invalid username.`);
	}

	const user = {
		password: password || "",
		log: enableLog,
	};

	this.database.query(
		"INSERT INTO users (username, config) VALUES(?, ?)",
		[name, JSON.stringify(user)],
		(err) => {
			if (err) {
				log.error(err);
			}
		}
	);

	return true;
};

ClientManager.prototype.getDataToSave = function(client) {
	const json = Object.assign({}, client.config, {
		networks: client.networks.map((n) => n.export()),
	});
	const newUser = JSON.stringify(json, null, "\t");

	return newUser;
};

ClientManager.prototype.saveUser = function(client, callback) {
	const newUser = this.getDataToSave(client);

	this.database.query(
		"UPDATE users SET config=? WHERE username=?",
		[newUser, client.name],
		(err) => {
			if (err) {
				log.error(err);
			}
		}
	);

	if (callback) {
		callback();
	}
	// TODO: save newUser
};

ClientManager.prototype.removeUser = function(name) {
	// TODO
	return true;
};
