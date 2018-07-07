/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018 Toha <tohenk@yahoo.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/*
 * Terminal handler.
 */

const AppTerm       = module.exports = exports;

const fs            = require('fs');
const ini           = require('ini');
const path          = require('path');
const util          = require('util');
const EventEmitter  = require('events');
const ntUtil        = require('./lib/util');
const AppStorage    = require('./storage');
const AppDispatcher = require('./dispatcher');

AppTerm.Storage = AppStorage;
AppTerm.ClientRoom = 'clients';

AppTerm.init = function(config) {
    this.config = config;
    this.operatorFilename = config.operatorFilename;
    this.configdir = config.configdir;
    this.countryCode = config.countryCode;
    this.pools = [];
    this.terminals = [];
    this.groups = [];
    this.gwclients = [];
    this.plugins = [];
    this.dispatcher = new AppDispatcher.Activity(this);
    return new Promise((resolve, reject) => {
        this.initializeLogger();
        AppStorage.init(config.database).then(() => {
            this.loadPlugins();
            this.loadOperator();
            resolve();
        }).catch((err) => {
            reject(err);
        });
    });
}

AppTerm.get = function(imsi) {
    var terminal = null;
    this.terminals.forEach((term) => {
        if (term.name == imsi) {
            terminal = term;
            return true;
        }
    });
    return terminal;
}

AppTerm.initializeLogger = function() {
    this.logdir = this.config.logdir || path.join(__dirname, 'logs');
    this.logfile = path.join(this.logdir, 'activity.log');
    this.stdout = new fs.createWriteStream(this.logfile, {
        flags: fs.existsSync(this.logfile) ? 'r+' : 'w'
    });
    this.logger = new console.Console(this.stdout);
}

AppTerm.loadPlugins = function() {
    if (this.config.plugins) {
        var plugins = Array.isArray(this.config.plugins) ? this.config.plugins : this.config.plugins.split(',');
        for (var i = 0; i < plugins.length; i++) {
            var plugin = plugins[i].trim();
            var pluginSrc;
            [plugin, path.join(__dirname, 'plugins', plugin)].forEach((file) => {
                if (fs.existsSync(file + '.js')) {
                    pluginSrc = file;
                    return true;
                }
            });
            if (!pluginSrc) {
                console.log('Unknown plugin: %s', plugin);
                continue;
            }
            var p = require(pluginSrc);
            if (typeof p == 'function') {
                var instance = new p(this);
                if (instance.name && typeof instance.handle == 'function') {
                    this.plugins.push(instance);
                    console.log('Plugin loaded: %s', plugin);
                } else {
                    console.log('Invalid plugin instance: %s', plugin);
                }
            }
        }
    }
    return this;
}

AppTerm.loadOperator = function() {
    if (this.operatorFilename && fs.existsSync(this.operatorFilename)) {
        this.operators = ini.parse(fs.readFileSync(this.operatorFilename, 'utf-8'));
    }
    return this;
}

AppTerm.getOperator = function(number) {
    if (!this.countryCode || this.countryCode == 'auto') {
        this.terminals.forEach((term) => {
            if (term.info.network.country) {
                this.countryCode = term.info.network.country;
                return true;
            }
        });
    }
    if (!this.countryCode || this.countryCode == 'auto') {
        throw new Error('Country code is not set.');
    }
    if (number.charAt(0) == '+') {
        number = '0' + number.substr(this.countryCode.length + 1);
    }
    var result;
    Object.keys(this.operators).forEach((operator) => {
        Object.values(this.operators[operator]).forEach((prefix) => {
            var prefixes = prefix.split('-');
            if (number.substr(0, prefixes[0].length) == prefixes[0]) {
                result = operator;
                return true;
            }
        });
        if (result) {
            return true;
        }
    });
    return result;
}

AppTerm.getNetworkOperator = function(imsi) {
    const term = this.get(imsi);
    if (term) return term.info.network.operator;
}

AppTerm.changed = function() {
    this.terminals = [];
    this.groups = {};
    this.pools.forEach((pool) => {
        pool.terminals.forEach((term) => {
            const group = term.options.group || '';
            this.terminals.push(term);
            if (!this.groups[group]) this.groups[group] = [];
            this.groups[group].push(term);
        });
    });
    if (this.plugins.length) {
        this.dispatcher.reload();
    }
}

AppTerm.setTermIo = function(io) {
    this.clientIo = io;
    this.config.pools.forEach((pool) => {
        const p = new this.Pool(this, pool);
        this.pools.push(p);
    });
    return this;
}

AppTerm.setSocketIo = function(io) {
    this.serverIo = io;
    this.uiCon = this.serverIo.of('/ui');
    this.uiCon.on('connection', (socket) => {
        console.log('UI client connected: %s', socket.id);
        socket.on('disconnect', () => {
            console.log('UI client disconnected: %s', socket.id);
        });
    });
    this.gwCon = this.serverIo.of('/gw');
    this.gwCon.on('connection', (socket) => {
        console.log('Gateway client connected: %s', socket.id);
        const timeout = setTimeout(() => {
            console.log('Closing connection due to no auth: %s', socket.id);
            socket.disconnect();
        }, 10000);
        socket.on('disconnect', () => {
            console.log('Gateway client disconnected: %s', socket.id);
            socket.leave(this.ClientRoom);
            const idx = this.gwclients.indexOf(socket);
            if (idx >= 0) {
                this.gwclients.splice(idx, 1);
            }
        });
        socket.on('auth', (secret) => {
            const authenticated = this.config.secret == secret;
            if (authenticated) {
                console.log('Client is authenticated: %s', socket.id);
                clearTimeout(timeout);
                this.gwclients.push(socket);
                this.dispatcher.reload();
                socket.join(this.ClientRoom);
            } else {
                console.log('Client is NOT authenticated: %s', socket.id);
            }
            socket.emit('auth', authenticated);
        });
        socket.on('group', (data) => {
            if (this.gwclients.indexOf(socket) < 0) return;
            console.log('Group changed for %s => %s', socket.id, data);
            socket.group = data;
        });
        socket.on('message', (data) => {
            if (this.gwclients.indexOf(socket) < 0) return;
            this.handleMessage(socket, data);
        });
        socket.on('message-retry', (data) => {
            if (this.gwclients.indexOf(socket) < 0) return;
            this.handleMessageRetry(socket, data);
        });
    });
    return this;
}

AppTerm.handleMessage = function(socket, data) {
    this.dispatcher.add({
        type: AppStorage.ACTIVITY_SMS,
        hash: data.hash || null,
        address: data.address,
        data: data.data
    }, socket.group, (queue) => {
        if (queue) {
            this.log('<-- SMS: %s', util.inspect({hash: queue.hash, address: queue.address, data: queue.data}));
            socket.emit('status', {
                type: queue.type,
                hash: queue.hash,
                time: queue.time,
                status: true
            });
            if (this.uiCon) {
                this.uiCon.emit('new-activity', queue.type);
            }
        }
    });
}

AppTerm.handleMessageRetry = function(socket, data) {
    this.log('<-- Checking SMS: %s', data.hash);
    const condition = {
        hash: data.hash,
        type: AppStorage.ACTIVITY_SMS
    }
    AppStorage.GwQueue.count({where: condition}).then((count) => {
        if (0 == count) {
            this.handleMessage(socket, data);
        } else {
            AppStorage.GwLog.findOne({where: condition}).then((gwlog) => {
                // message report already confirmed
                if (gwlog.code != null) {
                    socket.emit('status-report', {
                        hash: gwlog.hash,
                        address: gwlog.address,
                        code: gwlog.code,
                        sent: gwlog.sent,
                        received: gwlog.received,
                        time: gwlog.time
                    });
                } else if (gwlog.status == 0) {
                    AppStorage.GwQueue.findOne({where: condition}).then((gwqueue) => {
                        gwqueue.update({processed: 0, retry: null}).then(() => {
                            const term = this.get(gwqueue.imsi);
                            if (term) term.dispatcher.reload();
                        });
                    });
                }
            });
        }
    });
}

AppTerm.log = function() {
    var args = Array.from(arguments);
    if (args.length) {
        args[0] = ntUtil.formatDate(new Date(), 'dd-MM HH:mm:ss.zzz') + ' ' + args[0];
    }
    this.logger.log.apply(null, args);
    if (this.uiCon) {
        const message = util.format.apply(null, args);
        this.uiCon.emit('activity', {time: Date.now(), message: message});
    }
}

// Pool

AppTerm.Pool = function(parent, options) {
    this.parent = parent;
    this.name = options.name;
    this.url = options.url;
    this.key = options.key;
    this.terminals = [];
    this.init();
}

AppTerm.Pool.prototype.init = function() {
    this.con = this.parent.clientIo(this.url + '/ctrl');
    const done = (result) => {
        if (result) {
            this.parent.uiCon.emit('new-activity', result.type);
            this.parent.dispatcher.reload();
        }
    }
    this.con.on('connect', () => {
        console.log('Connected to terminal: %s', this.url);
        this.con.emit('auth', this.key);
    });
    this.con.on('disconnect', () => {
        console.log('Disconnected from: %s', this.url);
        this.reset(true);
    });
    this.con.on('auth', (success) => {
        if (success) {
            this.con.emit('init');
        } else {
            console.log('Authentication failed!');
        }
    });
    this.con.on('ready', (terms) => {
        console.log('Terminal ready: %s', util.inspect(terms));
        this.build(terms);
        this.con.emit('check-pending');
    });
    this.con.on('status-report', (data) => {
        this.parent.log('<-- REPORT: %s', util.inspect(data));
        AppStorage.updateReport(data.imsi, data);
        if (this.parent.gwCon) {
            this.parent.gwCon.to(this.parent.ClientRoom).emit('status-report', data);
        }
    });
    this.con.on('message', (data) => {
        this.parent.log('<-- MESSAGE: %s', util.inspect(data));
        AppStorage.saveQueue(data.imsi, {
            hash: data.hash,
            type: AppStorage.ACTIVITY_INBOX,
            address: data.address,
            data: data.data
        }, done);
    });
    this.con.on('ussd', (data) => {
        this.parent.log('<-- USSD: %s', util.inspect(data));
        AppStorage.saveQueue(data.imsi, {
            hash: data.hash,
            type: AppStorage.ACTIVITY_CUSD,
            address: data.address,
            data: data.data
        }, done);
        this.parent.uiCon.emit('ussd', {
            imsi: data.imsi,
            address: data.address,
            message: data.data
        });
    });
    this.con.on('ring', (data) => {
        this.parent.log('<-- RING: %s', util.inspect(data));
        AppStorage.saveQueue(data.imsi, {
            hash: data.hash,
            type: AppStorage.ACTIVITY_RING,
            address: data.address,
            data: null
        }, done);
    });
}

AppTerm.Pool.prototype.build = function(terms) {
    this.reset();
    terms.forEach((imsi) => {
        var con = this.parent.clientIo(this.url + '/' + imsi);
        var term = new AppTerm.Terminal(imsi, con, {
            configFilename: path.join(this.parent.configdir, imsi + '.cfg')
        });
        term.operatorList = Object.keys(this.parent.operators);
        this.terminals.push(term);
    });
    this.parent.changed();
}

AppTerm.Pool.prototype.reset = function(update) {
    this.terminals.forEach((term) => {
        delete term.dispatcher;
        term.con.disconnect();
    });
    this.terminals = [];
    if (update) this.parent.changed();
    return this;
}

// Terminal

AppTerm.Terminal = function(name, con, options) {
    var options = options || {};
    EventEmitter.call(this);
    this.name = name;
    this.con = con;
    this.connected = false;
    this.busy = false;
    this.options = this.defaultOptions();
    this.operatorList = [];
    if (options.configFilename) this.configFilename = options.configFilename;
    if (this.configFilename && fs.existsSync(this.configFilename)) {
        var config = JSON.parse(fs.readFileSync(this.configFilename, 'utf-8'));
        this.readOptions(config);
    } else {
        this.readOptions(options);
    }
    // terminal operation timeout is max at 10 seconds
    this.timeout = options.timeout || 12000;
    this.dispatcher = new AppDispatcher.Terminal(this);
    this.con.on('connect', () => {
        this.connected = true;
        this.syncOptions(false);
        this.getInfo().then(() => {
            this.info = this.reply;
            this.dispatcher.reload();
        });
    });
    this.con.on('disconnect', () => {
        this.connected = false;
        this.busy = false;
        this.synced = false;
    });
    this.con.on('state', (state) => {
        if (state.idle) {
            this.emit('idle');
        }
    });
}

util.inherits(AppTerm.Terminal, EventEmitter);

AppTerm.Terminal.prototype.defaultOptions = function() {
    return {
        rejectCall: false,
        allowCall: true,
        receiveMessage: true,
        sendMessage: true,
        deleteMessage: false,
        replyBlockedMessage: false,
        deliveryReport: true,
        requestReply: false,
        emptyWhenFull: false,
        priority: 0,
        group: null,
        operators: []
    }
}

AppTerm.Terminal.prototype.readOptions = function(options) {
    var newOptions = {};
    Object.keys(this.options).forEach((opt) => {
        if (typeof options[opt] != 'undefined') {
            newOptions[opt] = options[opt];
        }
    });
    this.applyOptions(newOptions);
    return this;
}

AppTerm.Terminal.prototype.applyOptions = function(options) {
    var oldOptions = JSON.stringify(this.options, null, 4);
    Object.assign(this.options, options);
    var newOptions = JSON.stringify(this.options, null, 4);
    if (oldOptions != newOptions) {
        this.syncOptions(true);
        if (this.configFilename) {
            fs.writeFile(this.configFilename, newOptions, (err) => {
                if (err) console.log(err);
            });
        }
    }
    return this;
}

AppTerm.Terminal.prototype.syncOptions = function(force) {
    if (!this.synced || force) {
        this.synced = true;
        this.con.once('getopt', (options) => {
            const setopts = {};
            Object.keys(options).forEach((opt) => {
                if (options[opt] != this.options[opt]) {
                    setopts[opt] = this.options[opt];
                }
            });
            if (Object.keys(setopts).length) {
                this.con.emit('setopt', setopts);
            }
        });
        this.con.emit('getopt');
    }
    return this;
}

AppTerm.Terminal.prototype.query = function(cmd, data) {
    if (!this.connected) {
        return new Promise((resolve, reject) => {
            reject('Not connected');
        });
    }
    return new Promise((resolve, reject) => {
        this.busy = true;
        this.reply = null;
        var timeout = null;
        var t = () => {
            this.busy = false;
            reject('Timeout');
        }
        this.con.once(cmd, (result) => {
            this.busy = false;
            this.reply = result;
            if (timeout) clearTimeout(timeout);
            resolve(this);
        });
        timeout = setTimeout(t, this.timeout);
        if (data) {
            this.con.emit(cmd, data);
        } else {
            this.con.emit(cmd);
        }
    });
}

AppTerm.Terminal.prototype.getInfo = function() {
    return this.query('info');
}

AppTerm.Terminal.prototype.dial = function(data) {
    return this.query('dial', data);
}

AppTerm.Terminal.prototype.sendMessage = function(data) {
    return this.query('message', data);
}

AppTerm.Terminal.prototype.ussd = function(data) {
    return this.query('ussd', data);
}

AppTerm.Terminal.prototype.fixData = function(data) {
    return new Promise((resolve, reject) => {
        if (!data.imsi) data.imsi = this.name;
        if (!data.time) data.time = new Date();
        if (!data.hash) {
            this.query('hash', data).then(() => {
                resolve(this.reply);
            }).catch(() => {
                resolve(data);
            });
        } else {
            resolve(data);
        }
    })
}

AppTerm.Terminal.prototype.addQueue = function(data, cb) {
    this.fixData(data).then((result) => {
        AppStorage.saveQueue(this.name, result, (queue) => {
            if (queue) {
                this.dispatcher.reload();
            }
            if (typeof cb == 'function') {
                cb(queue);
            }
        });
    });
}

AppTerm.Terminal.prototype.addCallQueue = function(phoneNumber, cb) {
    this.addQueue({
        imsi: this.name,
        type: AppStorage.ACTIVITY_CALL,
        address: phoneNumber
    }, cb);
}

AppTerm.Terminal.prototype.addMessageQueue = function(phoneNumber, message, cb) {
    this.addQueue({
        imsi: this.name,
        type: AppStorage.ACTIVITY_SMS,
        address: phoneNumber,
        data: message
    }, cb);
}

AppTerm.Terminal.prototype.addUssdQueue = function(service, cb) {
    this.addQueue({
        imsi: this.name,
        type: AppStorage.ACTIVITY_USSD,
        address: service
    }, cb);
}
