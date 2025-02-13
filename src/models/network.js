"use strict";

const _ = require("lodash");
const {v4: uuidv4} = require("uuid");
const IrcFramework = require("irc-framework");
const Chan = require("./chan");
const Msg = require("./msg");
const Helper = require("../helper");
const STSPolicies = require("../plugins/sts");

module.exports = Network;

/**
 * @type {Object} List of keys which should be sent to the client by default.
 */
const fieldsForClient = {
	uuid: true,
	name: true,
	nick: true,
	serverOptions: true,
};

function Network(attr) {
	_.defaults(this, attr, {
		name: "",
		nick: "",
		host: "",
		port: 6667,
		tls: false,
		userDisconnected: false,
		rejectUnauthorized: false,
		password: "",
		awayMessage: "",
		commands: [],
		username: "",
		realname: "",
		channels: [],
		irc: null,
		serverOptions: {
			CHANTYPES: ["#", "&"],
			PREFIX: ["!", "@", "%", "+"],
			NETWORK: "",
		},
		chanCache: [],
		ignoreList: [],
		keepNick: null,
	});

	if (!this.uuid) {
		this.uuid = uuidv4();
	}

	if (!this.name) {
		this.name = this.host;
	}

	this.channels.unshift(
		new Chan({
			name: this.name,
			type: Chan.Type.LOBBY,
		})
	);
}

Network.prototype.validate = function(client) {
	// Remove !, :, @ and whitespace characters from nicknames and usernames
	const cleanNick = (str) => str.replace(/[\x00\s:!@]/g, "_").substring(0, 100);

	// Remove new lines and limit length
	const cleanString = (str) => str.replace(/[\x00\r\n]/g, "").substring(0, 300);

	this.setNick(cleanNick(String(this.nick || Helper.getDefaultNick())));

	if (!this.username) {
		// If username is empty, make one from the provided nick
		this.username = this.nick.replace(/[^a-zA-Z0-9]/g, "");
	}

	this.username = cleanString(this.username) || "thelounge";
	this.realname = cleanString(this.realname) || "The Lounge User";
	this.password = cleanString(this.password);
	this.host = cleanString(this.host).toLowerCase();
	this.name = cleanString(this.name);

	if (!this.port) {
		this.port = this.tls ? 6697 : 6667;
	}

	if (Helper.config.lockNetwork) {
		// This check is needed to prevent invalid user configurations
		if (
			!Helper.config.public &&
			this.host &&
			this.host.length > 0 &&
			this.host !== Helper.config.defaults.host
		) {
			this.channels[0].pushMessage(
				client,
				new Msg({
					type: Msg.Type.ERROR,
					text: "Hostname you specified is not allowed.",
				}),
				true
			);

			return false;
		}

		this.host = Helper.config.defaults.host;
		this.port = Helper.config.defaults.port;
		this.tls = Helper.config.defaults.tls;
		this.rejectUnauthorized = Helper.config.defaults.rejectUnauthorized;
	}

	if (this.host.length === 0) {
		this.channels[0].pushMessage(
			client,
			new Msg({
				type: Msg.Type.ERROR,
				text: "You must specify a hostname to connect.",
			}),
			true
		);

		return false;
	}

	const stsPolicy = STSPolicies.get(this.host);

	if (stsPolicy && !this.tls) {
		this.channels[0].pushMessage(
			client,
			new Msg({
				type: Msg.Type.ERROR,
				text: `${this.host} has an active strict transport security policy, will connect to port ${stsPolicy.port} over a secure connection.`,
			}),
			true
		);

		this.port = stsPolicy.port;
		this.tls = true;
		this.rejectUnauthorized = true;
	}

	return true;
};

Network.prototype.createIrcFramework = function(client) {
	this.irc = new IrcFramework.Client({
		version: false, // We handle it ourselves
		host: this.host,
		port: this.port,
		nick: this.nick,
		username: Helper.config.useHexIp ? Helper.ip2hex(client.config.browser.ip) : this.username,
		gecos: this.realname,
		password: this.password,
		tls: this.tls,
		outgoing_addr: Helper.config.bind,
		rejectUnauthorized: this.rejectUnauthorized,
		enable_chghost: true,
		enable_echomessage: true,
		enable_setname: true,
		auto_reconnect: true,
		auto_reconnect_wait: 10000 + Math.floor(Math.random() * 1000), // If multiple users are connected to the same network, randomize their reconnections a little
		auto_reconnect_max_retries: 360, // At least one hour (plus timeouts) worth of reconnections
		webirc: this.createWebIrc(client),
	});

	this.irc.requestCap([
		"znc.in/self-message", // Legacy echo-message for ZNC
	]);

	// Request only new messages from ZNC if we have sqlite logging enabled
	// See http://wiki.znc.in/Playback
	if (client.config.log && client.messageStorage.find((s) => s.canProvideMessages())) {
		this.irc.requestCap("znc.in/playback");
	}
};

Network.prototype.createWebIrc = function(client) {
	if (
		!Helper.config.webirc ||
		!Object.prototype.hasOwnProperty.call(Helper.config.webirc, this.host)
	) {
		return null;
	}

	const webircObject = {
		password: Helper.config.webirc[this.host],
		username: "thelounge",
		address: client.config.browser.ip,
		hostname: client.config.browser.hostname,
	};

	// https://ircv3.net/specs/extensions/webirc#options
	if (client.config.browser.isSecure) {
		webircObject.options = {
			secure: true,
		};
	}

	if (typeof Helper.config.webirc[this.host] === "function") {
		webircObject.password = null;
		return Helper.config.webirc[this.host](webircObject, this);
	}

	return webircObject;
};

Network.prototype.edit = function(client, args) {
	const oldNick = this.nick;
	const oldRealname = this.realname;

	this.keepNick = null;
	this.nick = args.nick;
	this.host = String(args.host || "");
	this.name = String(args.name || "") || this.host;
	this.port = parseInt(args.port, 10);
	this.tls = !!args.tls;
	this.rejectUnauthorized = !!args.rejectUnauthorized;
	this.password = String(args.password || "");
	this.username = String(args.username || "");
	this.realname = String(args.realname || "");

	// Split commands into an array
	this.commands = String(args.commands || "")
		.replace(/\r\n|\r|\n/g, "\n")
		.split("\n")
		.filter((command) => command.length > 0);

	// Sync lobby channel name
	this.channels[0].name = this.name;

	if (!this.validate(client)) {
		return;
	}

	if (this.irc) {
		const connected = this.irc.connection && this.irc.connection.connected;

		if (this.nick !== oldNick) {
			if (connected) {
				// Send new nick straight away
				this.irc.changeNick(this.nick);
			} else {
				this.irc.options.nick = this.irc.user.nick = this.nick;

				// Update UI nick straight away if IRC is not connected
				client.emit("nick", {
					network: this.uuid,
					nick: this.nick,
				});
			}
		}

		if (
			connected &&
			this.realname !== oldRealname &&
			this.irc.network.cap.isEnabled("setname")
		) {
			this.irc.raw("SETNAME", this.realname);
		}

		this.irc.options.host = this.host;
		this.irc.options.port = this.port;
		this.irc.options.password = this.password;
		this.irc.options.gecos = this.irc.user.gecos = this.realname;
		this.irc.options.tls = this.tls;
		this.irc.options.rejectUnauthorized = this.rejectUnauthorized;

		if (!Helper.config.useHexIp) {
			this.irc.options.username = this.irc.user.username = this.username;
		}
	}

	client.save();
};

Network.prototype.destroy = function() {
	this.channels.forEach((channel) => channel.destroy());
};

Network.prototype.setNick = function(nick) {
	this.nick = nick;
	this.highlightRegex = new RegExp(
		// Do not match characters and numbers (unless IRC color)
		"(?:^|[^a-z0-9]|\x03[0-9]{1,2})" +
			// Escape nickname, as it may contain regex stuff
			_.escapeRegExp(nick) +
			// Do not match characters and numbers
			"(?:[^a-z0-9]|$)",

		// Case insensitive search
		"i"
	);

	if (this.keepNick === nick) {
		this.keepNick = null;
	}
};

/**
 * Get a clean clone of this network that will be sent to the client.
 * This function performs manual cloning of network object for
 * better control of performance and memory usage.
 *
 * Both of the parameters that are accepted by this function are passed into channels' getFilteredClone call.
 *
 * @see {@link Chan#getFilteredClone}
 */
Network.prototype.getFilteredClone = function(lastActiveChannel, lastMessage) {
	const filteredNetwork = Object.keys(this).reduce((newNetwork, prop) => {
		if (prop === "channels") {
			// Channels objects perform their own cloning
			newNetwork[prop] = this[prop].map((channel) =>
				channel.getFilteredClone(lastActiveChannel, lastMessage)
			);
		} else if (fieldsForClient[prop]) {
			// Some properties that are not useful for the client are skipped
			newNetwork[prop] = this[prop];
		}

		return newNetwork;
	}, {});

	filteredNetwork.status = this.getNetworkStatus();

	return filteredNetwork;
};

Network.prototype.getNetworkStatus = function() {
	const status = {
		connected: false,
		secure: false,
	};

	if (this.irc && this.irc.connection && this.irc.connection.transport) {
		const transport = this.irc.connection.transport;

		if (transport.socket) {
			const isLocalhost = transport.socket.remoteAddress === "127.0.0.1";
			const isAuthorized = transport.socket.encrypted && transport.socket.authorized;

			status.connected = transport.isConnected();
			status.secure = isAuthorized || isLocalhost;
		}
	}

	return status;
};

Network.prototype.addChannel = function(newChan) {
	let index = this.channels.length; // Default to putting as the last item in the array

	// Don't sort special channels in amongst channels/users.
	if (newChan.type === Chan.Type.CHANNEL || newChan.type === Chan.Type.QUERY) {
		// We start at 1 so we don't test against the lobby
		for (let i = 1; i < this.channels.length; i++) {
			const compareChan = this.channels[i];

			// Negative if the new chan is alphabetically before the next chan in the list, positive if after
			if (
				newChan.name.localeCompare(compareChan.name, {sensitivity: "base"}) <= 0 ||
				(compareChan.type !== Chan.Type.CHANNEL && compareChan.type !== Chan.Type.QUERY)
			) {
				index = i;
				break;
			}
		}
	}

	this.channels.splice(index, 0, newChan);
	return index;
};

Network.prototype.quit = function(quitMessage) {
	if (!this.irc) {
		return;
	}

	// https://ircv3.net/specs/extensions/sts#rescheduling-expiry-on-disconnect
	STSPolicies.refreshExpiration(this.host);

	this.irc.quit(quitMessage || Helper.config.leaveMessage);
};

Network.prototype.exportForEdit = function() {
	let fieldsToReturn;

	if (Helper.config.displayNetwork) {
		// Return fields required to edit a network
		fieldsToReturn = [
			"uuid",
			"nick",
			"name",
			"host",
			"port",
			"tls",
			"rejectUnauthorized",
			"password",
			"username",
			"realname",
			"commands",
		];
	} else {
		// Same fields as in getClientConfiguration when network is hidden
		fieldsToReturn = ["name", "nick", "username", "password", "realname"];
	}

	const data = _.pick(this, fieldsToReturn);

	data.hasSTSPolicy = !!STSPolicies.get(this.host);

	return data;
};

Network.prototype.export = function() {
	const network = _.pick(this, [
		"uuid",
		"awayMessage",
		"nick",
		"name",
		"host",
		"port",
		"tls",
		"userDisconnected",
		"rejectUnauthorized",
		"password",
		"username",
		"realname",
		"commands",
		"ignoreList",
	]);

	network.channels = this.channels
		.filter(function(channel) {
			return channel.type === Chan.Type.CHANNEL || channel.type === Chan.Type.QUERY;
		})
		.map(function(chan) {
			const keys = ["name"];

			if (chan.type === Chan.Type.CHANNEL) {
				keys.push("key");
			} else if (chan.type === Chan.Type.QUERY) {
				keys.push("type");
			}

			return _.pick(chan, keys);
		});

	return network;
};

Network.prototype.getChannel = function(name) {
	name = name.toLowerCase();

	return _.find(this.channels, function(that, i) {
		// Skip network lobby (it's always unshifted into first position)
		return i > 0 && that.name.toLowerCase() === name;
	});
};
