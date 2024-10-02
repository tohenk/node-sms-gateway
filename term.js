/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018-2024 Toha <tohenk@yahoo.com>
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

const fs = require('fs');
const ini = require('ini');
const path = require('path');
const util = require('util');
const EventEmitter = require('events');
const Logger = require('@ntlab/ntlib/logger');
const { Work } = require('@ntlab/work');
const AppStorage = require('./storage');
const { AppTerminalDispatcher, AppActivityDispatcher } = require('./dispatcher');

class AppTerm {

    Storage = AppStorage
    ClientRoom = 'client'
    UiRoom = 'ui'

    init(config) {
        this.config = config;
        this.operatorFilename = config.operatorFilename;
        this.configdir = config.configdir;
        this.countryCode = config.countryCode;
        this.pools = [];
        this.terminals = [];
        this.groups = [];
        this.gwclients = [];
        this.plugins = [];
        this.dispatcher = new AppActivityDispatcher(this);
        this.dispatcher.on('queue-processed', queue => this.uiSend('queue-processed', queue));
        return Work.works([
            [w => this.initializeLogger()],
            [w => AppStorage.init(config.database)],
            [w => this.loadPlugins()],
            [w => this.loadOperator()],
        ]);
    }

    initializeLogger() {
        return new Promise((resolve, reject) => {
            this.logdir = this.config.logdir || path.join(__dirname, 'logs');
            this.logfile = path.join(this.logdir, 'gateway.log');
            this.logger = new Logger(this.logfile);
            resolve();
        });
    }

    loadPlugins() {
        if (!this.config.plugins) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            // create plugins data directory if needed
            if (!fs.existsSync(this.config.datadir)) {
                fs.mkdirSync(this.config.datadir);
            }
            const plugins = Array.isArray(this.config.plugins) ? this.config.plugins : this.config.plugins.split(',');
            for (let i = 0; i < plugins.length; i++) {
                const plugin = plugins[i].trim();
                let pluginSrc;
                [
                    plugin,
                    path.join(__dirname, 'plugins', plugin),
                    path.join(__dirname, 'plugins', plugin, 'index')
                ].forEach(file => {
                    if (fs.existsSync(file + '.js')) {
                        pluginSrc = file;
                        return true;
                    }
                });
                if (!pluginSrc) {
                    // is plugin a package
                    const res = require.resolve(plugin);
                    if (res) {
                        pluginSrc = res;
                    }
                    if (!pluginSrc) {
                        console.log('Unknown plugin: %s', plugin);
                        continue;
                    }
                }
                const p = require(pluginSrc);
                if (typeof p === 'function') {
                    const instance = new p(this);
                    if (instance.name && typeof instance.handle === 'function') {
                        instance.src = pluginSrc;
                        if (typeof instance.initialize === 'function') {
                            instance.initialize();
                        }
                        this.plugins.push(instance);
                        console.log('Plugin loaded: %s', plugin);
                    } else {
                        console.log('Invalid plugin instance: %s', plugin);
                    }
                }
            }
            resolve();
        });
    }

    loadOperator() {
        return new Promise((resolve, reject) => {
            if (this.operatorFilename && fs.existsSync(this.operatorFilename)) {
                this.operators = ini.parse(fs.readFileSync(this.operatorFilename, 'utf-8'));
            }
            resolve();
        });
    }

    get(imsi) {
        let terminal = null;
        this.terminals.forEach(term => {
            if (term.name === imsi) {
                terminal = term;
                return true;
            }
        });
        return terminal;
    }

    getOperator(number) {
        if (!this.countryCode || this.countryCode === 'auto') {
            this.terminals.forEach(term => {
                if (term.info.network.country) {
                    this.countryCode = term.info.network.country;
                    return true;
                }
            });
        }
        if (!this.countryCode || this.countryCode === 'auto') {
            throw new Error('Country code is not set.');
        }
        if (number.charAt(0) === '+') {
            number = '0' + number.substr(this.countryCode.length + 1);
        }
        let result;
        Object.keys(this.operators).forEach(operator => {
            Object.values(this.operators[operator]).forEach(prefix => {
                const prefixes = prefix.split('-');
                if (number.substr(0, prefixes[0].length) === prefixes[0]) {
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

    getNetworkOperator(imsi) {
        const term = this.get(imsi);
        if (term) {
            return term.info.network.operator;
        }
    }

    changed() {
        this.terminals = [];
        this.groups = {};
        this.pools.forEach(pool => {
            pool.terminals.forEach(term => {
                const group = term.options.group || '';
                this.terminals.push(term);
                if (!this.groups[group]) {
                    this.groups[group] = [];
                }
                this.groups[group].push(term);
            });
        });
        if (this.plugins.length) {
            this.dispatcher.reload();
        }
    }

    setTermIo(io) {
        this.clientIo = io;
        this.config.pools.forEach(pool => {
            const p = new AppTermPool(this, pool);
            this.pools.push(p);
        });
        return this;
    }

    setSocketIo(io) {
        this.serverIo = io;
        this.uiCon = this.serverIo.of('/ui');
        this.uiCon.on('connection', socket => {
            console.log('UI client connected: %s', socket.id);
            socket.join(this.UiRoom);
            socket.on('disconnect', () => {
                console.log('UI client disconnected: %s', socket.id);
                socket.leave(this.UiRoom);
            });
        });
        this.gwCon = this.serverIo.of('/gw');
        this.gwCon.on('connection', socket => {
            console.log('Gateway client connected: %s', socket.id);
            socket.time = new Date();
            const timeout = setTimeout(() => {
                console.log('Closing connection due to no auth: %s', socket.id);
                socket.disconnect();
            }, 10000);
            socket.on('disconnect', () => {
                console.log('Gateway client disconnected: %s', socket.id);
                socket.leave(this.ClientRoom);
                if (socket.group) {
                    socket.leave(socket.group);
                }
                const idx = this.gwclients.indexOf(socket);
                if (idx >= 0) {
                    this.gwclients.splice(idx, 1);
                    this.uiSend('client');
                }
            });
            socket.on('auth', secret => {
                const authenticated = this.config.secret === secret;
                if (authenticated) {
                    console.log('Client is authenticated: %s', socket.id);
                    clearTimeout(timeout);
                    if (this.gwclients.indexOf(socket) < 0) {
                        this.gwclients.push(socket);
                    }
                    this.dispatcher.reload();
                    socket.join(this.ClientRoom);
                    this.uiSend('client');
                } else {
                    console.log('Client is NOT authenticated: %s', socket.id);
                }
                socket.emit('auth', authenticated);
            });
            socket.on('group', data => {
                if (this.gwclients.indexOf(socket) < 0) {
                    return;
                }
                console.log('Group changed for %s => %s', socket.id, data);
                if (socket.group) {
                    socket.leave(socket.group);
                }
                socket.group = data;
                socket.join(socket.group);
            });
            socket.on('message', data => {
                if (this.gwclients.indexOf(socket) < 0) {
                    return;
                }
                this.handleMessage(socket, data);
            });
            socket.on('message-retry', data => {
                if (this.gwclients.indexOf(socket) < 0) {
                    return;
                }
                this.handleMessageRetry(socket, data);
            });
        });
        return this;
    }

    uiSend(message, data = null) {
        if (this.uiCon) {
            if (data) {
                this.uiCon.to(this.UiRoom).emit(message, data);
            } else {
                this.uiCon.to(this.UiRoom).emit(message);
            }
        }
    }

    handleMessage(socket, data) {
        this.dispatcher.add({
            type: AppStorage.ACTIVITY_SMS,
            hash: data.hash || null,
            address: data.address,
            data: data.data
        }, socket.group, queue => {
            if (queue) {
                this.log('<-- SMS: %s', util.inspect({hash: queue.hash, address: queue.address, data: queue.data}));
                socket.emit('status', {
                    type: queue.type,
                    hash: queue.hash,
                    time: queue.time,
                    status: true
                });
                this.uiSend('new-activity', queue.type);
            }
        });
    }

    handleMessageRetry(socket, data) {
        this.log('<-- Checking SMS: %s', data.hash);
        const condition = {
            hash: data.hash,
            type: AppStorage.ACTIVITY_SMS
        }
        AppStorage.GwQueue.count({where: condition})
            .then(count => {
                if (0 === count) {
                    this.handleMessage(socket, data);
                } else {
                    AppStorage.GwLog.findOne({where: condition})
                        .then(gwlog => {
                            // message report already confirmed
                            if (gwlog.code !== null) {
                                socket.emit('status-report', {
                                    hash: gwlog.hash,
                                    address: gwlog.address,
                                    code: gwlog.code,
                                    sent: gwlog.sent,
                                    received: gwlog.received,
                                    time: gwlog.time
                                });
                            } else if (gwlog.status === 0) {
                                AppStorage.GwQueue.findOne({where: condition})
                                    .then(gwqueue => {
                                        const updates = {processed: false, retry: null};
                                        let term = this.get(gwqueue.imsi);
                                        // allow to use other terminal in case destined terminal is not exist
                                        // or not able to send message
                                        if (!term || !term.options.sendMessage) {
                                            term = this.dispatcher.selectTerminal(AppStorage.ACTIVITY_SMS, gwqueue.address, socket.group);
                                            if (term) {
                                                updates.imsi = term.name;
                                                console.log('Relocating message %s using %s', data.hash, term.name);
                                            }
                                        }
                                        // only retry when terminal is available
                                        if (term) {
                                            gwqueue.update(updates)
                                                .then(() => {
                                                    console.log('Resetting message %s status for retry', data.hash);
                                                    term.dispatcher.reload();
                                                })
                                            ;
                                        }
                                    })
                                ;
                            }
                        })
                    ;
                }
            })
        ;
    }

    log() {
        this.logger.log.apply(this.logger, Array.from(arguments))
            .then(message => {
                this.uiSend('activity', {time: Date.now(), message: message});
            })
        ;
    }
}

class AppTermPool {

    constructor(parent, options) {
        this.parent = parent;
        this.name = options.name;
        this.url = options.url;
        this.key = options.key;
        this.terminals = [];
        this.init();
    }

    init() {
        this.con = this.parent.clientIo(this.url + '/ctrl');
        const done = result => {
            if (result) {
                this.parent.uiSend('new-activity', result.type);
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
        this.con.on('auth', success => {
            if (success) {
                this.con.emit('init');
            } else {
                console.log('Authentication failed!');
            }
        });
        this.con.on('ready', terms => {
            console.log('Terminal ready: %s', util.inspect(terms));
            this.build(terms);
        });
        this.con.on('status-report', data => {
            this.parent.log('<-- REPORT: %s', util.inspect(data));
            AppStorage.updateReport(data.imsi, data);
            if (this.parent.gwCon) {
                const term = this.parent.get(data.imsi);
                const room = term && term.options.group ? term.options.group : this.parent.ClientRoom;
                this.parent.gwCon.to(room).emit('status-report', data);
            }
        });
        this.con.on('message', data => {
            this.parent.log('<-- MESSAGE: %s', util.inspect(data));
            AppStorage.saveQueue(data.imsi, {
                hash: data.hash,
                type: AppStorage.ACTIVITY_INBOX,
                address: data.address,
                data: data.data
            }, done);
        });
        this.con.on('ussd', data => {
            this.parent.log('<-- USSD: %s', util.inspect(data));
            AppStorage.saveQueue(data.imsi, {
                hash: data.hash,
                type: AppStorage.ACTIVITY_CUSD,
                address: data.address,
                data: data.data
            }, done);
            this.parent.uiSend('ussd', {
                imsi: data.imsi,
                address: data.address,
                message: data.data
            });
        });
        this.con.on('ring', data => {
            this.parent.log('<-- RING: %s', util.inspect(data));
            AppStorage.saveQueue(data.imsi, {
                hash: data.hash,
                type: AppStorage.ACTIVITY_RING,
                address: data.address,
                data: null
            }, done);
        });
    }

    checkPending() {
        if (this.con && this.terminals.length) {
            this.con.emit('check-pending');
        }
    }

    build(terms) {
        this.reset();
        terms.forEach(imsi => {
            const con = this.parent.clientIo(this.url + '/' + imsi);
            const term = new AppTerminal(imsi, con, {configFilename: path.join(this.parent.configdir, imsi + '.cfg')});
            term.operatorList = Object.keys(this.parent.operators);
            term
                .on('pre-queue', queue => {
                    this.parent.uiSend('queue', queue);
                })
                .on('post-queue', queue => {
                    this.parent.uiSend('queue-done', queue);
                })
            ;
            this.terminals.push(term);
        });
        let timeout;
        const f = () => {
            let readyCnt = 0;
            this.terminals.forEach(term => {
                if (term.connected) {
                    readyCnt++;
                }
            });
            if (terms.length && readyCnt === terms.length) {
                if (timeout !== undefined) {
                    clearTimeout(timeout);
                }
                this.checkPending();
            } else {
                timeout = setTimeout(f, 500);
            }
        }
        f();
        this.parent.changed();
    }

    reset(update) {
        this.terminals.forEach(term => {
            delete term.dispatcher;
            term.con.disconnect();
        });
        this.terminals = [];
        if (update) {
            this.parent.changed();
        }
        return this;
    }
}

class AppTerminal extends EventEmitter {

    constructor(name, con, options) {
        super();
        options = options || {};
        this.name = name;
        this.con = con;
        this.connected = false;
        this.busy = false;
        this.options = this.defaultOptions();
        this.operatorList = [];
        if (options.configFilename) {
            this.configFilename = options.configFilename;
        }
        if (this.configFilename && fs.existsSync(this.configFilename)) {
            this.readOptions(JSON.parse(fs.readFileSync(this.configFilename, 'utf-8')));
        } else {
            this.readOptions(options);
        }
        // terminal operation timeout is max at 10 seconds
        this.timeout = options.timeout || 12000;
        this.dispatcher = new AppTerminalDispatcher(this);
        this.dispatcher
            .on('pre-queue', queue => {
                this._queue = queue;
                this.emit('pre-queue', queue);
            })
            .on('post-queue', queue => {
                this.emit('post-queue', queue);
            })
        ;
        this.con.on('connect', () => {
            this.connected = true;
            this.syncOptions(false);
            this.getInfo()
                .then(info => {
                    this.info = info;
                    this.dispatcher.reload();
                })
            ;
        });
        this.con.on('disconnect', () => {
            this.connected = false;
            this.busy = false;
            this.synced = false;
        });
        this.con.on('state', state => {
            if (state.idle) {
                this.emit('idle');
            }
        });
    }

    defaultOptions() {
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

    readOptions(options) {
        const newOptions = {};
        Object.keys(this.options).forEach(opt => {
            if (options[opt] !== undefined) {
                newOptions[opt] = options[opt];
            }
        });
        this.applyOptions(newOptions);
        return this;
    }

    applyOptions(options) {
        const oldOptions = JSON.stringify(this.options, null, 4);
        Object.assign(this.options, options);
        const newOptions = JSON.stringify(this.options, null, 4);
        if (oldOptions != newOptions) {
            this.syncOptions(true);
            if (this.configFilename) {
                fs.writeFile(this.configFilename, newOptions, err => {
                    if (err) {
                        console.error(err);
                    }
                });
            }
        }
        return this;
    }

    syncOptions(force) {
        if (!this.synced || force) {
            this.synced = true;
            this.con.once('getopt', options => {
                const setopts = {};
                Object.keys(options).forEach(opt => {
                    if (options[opt] !== this.options[opt]) {
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

    query(cmd, data) {
        if (!this.connected) {
            return Promise.reject('Not connected');
        }
        return new Promise((resolve, reject) => {
            this.busy = true;
            this.reply = null;
            let timeout = null;
            const t = () => {
                this.busy = false;
                reject('Timeout');
            }
            this.con.once(cmd, result => {
                this.busy = false;
                this.reply = result;
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve(result);
            });
            timeout = setTimeout(t, this.timeout);
            if (data) {
                this.con.emit(cmd, data);
            } else {
                this.con.emit(cmd);
            }
        });
    }

    getStat() {
        return new Promise((resolve, reject) => {
            const res = {
                unprocessed: {
                    label: 'Unprocessed queue',
                    value: this.dispatcher.queues.length
                },
                last: {
                    label: 'Last queue',
                    value: this._queue ? this._queue.hash.substr(0, 8) : null
                }
            }
            AppStorage.countStats(this.name)
                .then(rows => {
                    rows.forEach(row => {
                        res[row.type == 1 ? 'fail' : 'success'] = {
                            label: row.type == 1 ? 'Total failed queues' : 'Total succeeded queues',
                            value: row.count
                        }
                    });
                    resolve(res);
                })
                .catch(err => reject(err));
        });
    }

    getInfo() {
        return this.query('info');
    }

    dial(data) {
        return this.query('dial', data);
    }

    sendMessage(data) {
        return this.query('message', data);
    }

    ussd(data) {
        return this.query('ussd', data);
    }

    fixData(data) {
        return new Promise((resolve, reject) => {
            if (!data.imsi) {
                data.imsi = this.name;
            }
            if (!data.time) {
                data.time = new Date();
            }
            if (!data.hash) {
                this.query('hash', data)
                    .then(result => resolve(result))
                    .catch(err => {
                        console.error(err);
                        resolve(data);
                    })
                ;
            } else {
                resolve(data);
            }
        })
    }

    addQueue(data, cb) {
        this.fixData(data)
            .then(result => {
                AppStorage.saveQueue(this.name, result, queue => {
                    if (queue) {
                        this.dispatcher.reload();
                    }
                    if (typeof cb === 'function') {
                        cb(queue);
                    }
                });
            })
        ;
    }

    addCallQueue(phoneNumber, cb) {
        this.addQueue({
            imsi: this.name,
            type: AppStorage.ACTIVITY_CALL,
            address: phoneNumber
        }, cb);
    }

    addMessageQueue(phoneNumber, message, cb) {
        this.addQueue({
            imsi: this.name,
            type: AppStorage.ACTIVITY_SMS,
            address: phoneNumber,
            data: message
        }, cb);
    }

    addUssdQueue(service, cb) {
        this.addQueue({
            imsi: this.name,
            type: AppStorage.ACTIVITY_USSD,
            address: service
        }, cb);
    }
}

module.exports = new AppTerm();