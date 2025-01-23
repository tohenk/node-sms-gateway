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

const EventEmitter = require('events');
const { Op } = require('@sequelize/core');
const AppStorage = require('./storage');

/**
 * Queue dispatcher.
 */
class AppDispatcher extends EventEmitter {

    constructor() {
        super();
        this.count = 0;
        this.queues = [];
        this.inqueues = [];
        this.loading = false;
        this.loadTime = Date.now();
        this.reloadInterval = 300000; // 5 minutes
    }

    reload() {
        this.count++;
        this.check();
        return this;
    }

    load() {
        if (this.count > 0 && !this.loading) {
            this.loading = true;
            this.count = 0;
            this.queues = [];
            this.getQueues(results => {
                this.loading = false;
                this.loadTime = Date.now();
                this.queues = results;
                this.check();
            });
        }
    }

    getQueues(done) {
    }

    inQueue(item) {
        const result = this.inqueues.indexOf(item) >= 0 ? true : false;
        if (!result) {
            this.inqueues.push(item);
        }
        return result;
    }

    endQueue(item) {
        const index = this.inqueues.indexOf(item);
        if (index >= 0) {
            this.inqueues.splice(index, 1);
        }
        return this;
    }

    check() {
    }

    reloadIfNeeded() {
        if (this.count > 0 || (this.count === 0 && this.queues.length === 0)) {
            if (this.count === 0 && ((Date.now() - this.loadTime) >= this.reloadInterval) && !this.loading) {
                this.count++;
            }
            this.load();
        }
    }
}

/**
 * Terminal Dispatcher.
 */
class AppTerminalDispatcher extends AppDispatcher {

    constructor(term) {
        super();
        this.maxRetry = 3;
        this.term = term;
        this.term.on('idle', () => {
            this.reloadIfNeeded();
            if (this.queues.length && !this.term.busy) {
                const queue = this.queues.shift();
                if (!this.inQueue(queue.id)) {
                    console.log('Processing queue: %s <= %s (%d)', queue.imsi, queue.hash, queue.id);
                    this.emit('pre-queue', queue);
                    this.process(queue);
                }
            }
            this.check();
        });
    }

    getQueues(done) {
        AppStorage.GwQueue.findAll({
            where: {
                imsi: this.term.name,
                [Op.or]: [
                    {
                        [Op.and]: [
                            {processed: false},
                            {type: {[Op.in]: [AppStorage.ACTIVITY_CALL, AppStorage.ACTIVITY_SMS, AppStorage.ACTIVITY_USSD]}}
                        ]
                    },
                    {
                        [Op.and]: [
                            {processed: true},
                            {retry: {[Op.lt]: this.maxRetry}},
                            {type: AppStorage.ACTIVITY_SMS},
                            {status: 0}
                        ]
                    }
                ]
            },
            order: [
                ['priority', 'ASC'],
                ['processed', 'ASC'],
                ['time', 'ASC']
            ]
        })
            .then(results => {
                done(results);
            })
        ;
    }

    check() {
        this.term.con.emit('state');
        return this;
    }

    update(GwQueue, success) {
        const updates = {processed: true};
        if (success) {
            updates.status = this.term.reply.success ? 1 : 0;
        }
        if (!success && GwQueue.type === AppStorage.ACTIVITY_SMS) {
            updates.retry = GwQueue.retry ? GwQueue.retry + 1 : 1;
        }
        GwQueue.update(updates)
            .then(result => {
                if (GwQueue.type !== AppStorage.ACTIVITY_USSD) {
                    AppStorage.saveLog(GwQueue.imsi, result, GwLog => this.endQueue(GwQueue.id));
                } else {
                    this.endQueue(GwQueue.id);
                }
            })
            .catch(err => {
                console.error(err);
                this.endQueue(GwQueue.id);
            })
        ;
    }

    process(GwQueue) {
        const f = action => {
            if (action) {
                action
                    .then(result => {
                        this.update(GwQueue, result.success);
                    })
                    .catch(() => {
                        this.update(GwQueue, false);
                    })
                    .finally(() => {
                        console.log('Queue done: %s <= %s (%d)', GwQueue.imsi, GwQueue.hash, GwQueue.id);
                        this.emit('post-queue', GwQueue);
                    });
                ;
            }
        }
        switch (GwQueue.type) {
            case AppStorage.ACTIVITY_CALL:
                f(this.term.dial(GwQueue));
                break;
            case AppStorage.ACTIVITY_SMS:
                // if it is a message retry then ensure the status is really failed
                if (GwQueue.retry !== null) {
                    this.term.query('status', GwQueue.hash)
                        .then(status => {
                            if (status.success && status.hash === GwQueue.hash) {
                                if (status.status) {
                                    // it was success, update status
                                    GwQueue.update({status: 1});
                                } else {
                                    // retry message
                                    f(this.term.sendMessage(GwQueue));
                                }
                            } else {
                                // message not processed yet, okay to send
                                f(this.term.sendMessage(GwQueue));
                            }
                        })
                    ;
                } else {
                    f(this.term.sendMessage(GwQueue));
                }
                break;
            case AppStorage.ACTIVITY_USSD:
                f(this.term.ussd(GwQueue));
                break;
        }
    }
}

/**
 * Activity dispatcher.
 */
class AppActivityDispatcher extends AppDispatcher {

    constructor(appterm) {
        super();
        this.appterm = appterm;
        this.processing = false;
    }

    getQueues(done) {
        AppStorage.GwQueue.findAll({
            where: {
                processed: false,
                type: {[Op.in]: [AppStorage.ACTIVITY_RING, AppStorage.ACTIVITY_INBOX, AppStorage.ACTIVITY_CUSD]}
            },
            order: [
                ['priority', 'ASC'],
                ['time', 'ASC']
            ]
        })
            .then(results => {
                done(results);
            })
        ;
    }

    check() {
        if (this.appterm.terminals.length) {
            if (this.appterm.gwclients.length === 0 && this.appterm.plugins.length === 0) {
                console.log('Activity processing skipped, no consumer registered.');
            } else {
                this.reloadIfNeeded();
                this.process();
            }
        }
        return this;
    }

    add(data, group, cb) {
        const term = this.selectTerminal(data.type, data.address, group);
        if (!term) {
            console.log('No terminal available for activity %s => %s (%s)', data.type,
                data.address, group ? group : '-');
        } else {
            term.addQueue(data, cb);
        }
    }

    selectTerminal(type, address, group) {
        const terminals = this.getTerminal(type, address, group);
        if (terminals.length) {
            let index = 0;
            if (terminals.length > 1) {
                terminals.sort((a, b) => a.options.priority - b.options.priority);
                index = Math.floor(Math.random() * terminals.length);
            }
            return terminals[index];
        }
    }

    getTerminal(type, address, group) {
        const result = [];
        const priorities = [];
        for (let i = 0; i < this.appterm.terminals.length; i++) {
            const term = this.appterm.terminals[i];
            if (!term.connected) {
                continue;
            }
            if (group && !term.options.groups.includes(group)) {
                continue;
            }
            if (type === AppStorage.ACTIVITY_CALL && !term.options.allowCall) {
                continue;
            }
            if (type === AppStorage.ACTIVITY_SMS && !term.options.sendMessage) {
                continue;
            }
            if (term.options.operators.length && type !== AppStorage.ACTIVITY_USSD) {
                const op = this.appterm.getOperator(address);
                if (!op) {
                    continue;
                }
                if (term.options.operators.indexOf(op) < 0) {
                    continue;
                }
                // give an assigned operator as priority
                priorities.push(term);
            }
            result.push(term);
        }
        if (result.length > 1 && priorities.length) {
            Array.prototype.push.apply(result, priorities);
        }
        return result;
    }

    process() {
        if (this.queues.length && !this.processing) {
            this.processing = true;
            process.nextTick(() => {
                if (this.queues.length) {
                    const queue = this.queues.shift();
                    this.emit('queue', queue);
                }
            });
            this.once('queue', queue => {
                this.processQueue(queue, () => {
                    this.processing = false;
                    this.emit('queue-processed', queue);
                    this.check();
                });
            });
        }
        if (this.queues.length === 0) {
            if (!this.timeout) {
                this.timeout = setTimeout(() => {
                    this.timeout = null;
                    this.check();
                }, this.reloadInterval);
            }
        }
    }

    processQueue(GwQueue, done) {
        const term = this.appterm.get(GwQueue.imsi);
        if (term) {
            let processed = true;
            if (GwQueue.type === AppStorage.ACTIVITY_RING || GwQueue.type === AppStorage.ACTIVITY_INBOX) {
                processed = this.addressAllowed(GwQueue.address) ? true : false;
            }
            // skip message based its terminal setting
            if (processed && !term.options.receiveMessage && GwQueue.type === AppStorage.ACTIVITY_INBOX) {
                processed = false;
            }
            if (processed) {
                if (this.appterm.gwclients.length) {
                    this.appterm.gwclients.forEach(socket => {
                        if (term.options.groups.includes(socket.group) || (term.options.groups.length === 0 && !socket.group)) {
                            console.log('Sending activity notification %d-%s to %s', GwQueue.type,
                                GwQueue.hash, socket.id);
                            switch (GwQueue.type) {
                                case AppStorage.ACTIVITY_RING:
                                    socket.emit('ring', GwQueue.hash, GwQueue.address, GwQueue.time);
                                    break;
                                case AppStorage.ACTIVITY_INBOX:
                                    socket.emit('message', GwQueue.hash, GwQueue.address, GwQueue.data, GwQueue.time);
                                    break;
                                case AppStorage.ACTIVITY_CUSD:
                                    socket.emit('ussd', GwQueue.hash, GwQueue.address, GwQueue.data, GwQueue.time);
                                    break;
                            }
                        } else {
                            console.log('Skipping activity notification %d-%s for %s', GwQueue.type,
                                GwQueue.hash, socket.id);
                        }
                    });
                }
                this.appterm.plugins.forEach(plugin => {
                    if (plugin.group === undefined || term.options.groups.includes(plugin.group)) {
                        plugin.handle(GwQueue);
                        if (GwQueue.veto) {
                            return true;
                        }
                    }
                });
            }
            GwQueue.update({processed: true, status: processed ? 1 : 0})
                .then(() => done())
                .catch(err => {
                    console.error(err);
                    done();
                })
            ;
        } else {
            done();
        }
    }

    addressAllowed(address) {
        if (address) {
            const blacklists = this.appterm.config.blacklists || [];
            const premiumlen = this.appterm.config.premiumlen || 5;
            if (isNaN(address)) {
                console.log('Number %s is unreachable', address);
                return false;
            }
            if (address.length <= premiumlen) {
                console.log('Number %s is premium', address);
                return false;
            }
            if (blacklists.indexOf(address) >= 0) {
                console.log('Number %s is blacklisted', address);
                return false;
            }
            return true;
        }
    }
}

module.exports = {
    AppDispatcher,
    AppTerminalDispatcher,
    AppActivityDispatcher,
}