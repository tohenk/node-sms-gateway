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
 * Prepaid plugin.
 */

module.exports = exports = PluginPrepaid;

const fs = require('fs');
const path = require('path');
const moment = require('moment');

const ACTIVITY_CALL = 1;
const ACTIVITY_RING = 2;
const ACTIVITY_SMS = 3;
const ACTIVITY_INBOX = 4;
const ACTIVITY_USSD = 5;
const ACTIVITY_CUSD = 6;

function PluginPrepaid(appterm) {
    this.name = 'prepaid';
    this.title = 'Prepaid';
    this.description = 'Prepaid allows checking for balance and active period for prepaid card';
    this.icon = 'dollar sign';
    this.appterm = appterm;
    this.data = {};
}

PluginPrepaid.prototype.initialize = function() {
    this.prepaid = JSON.parse(fs.readFileSync(path.join(__dirname, 'prepaid.json')));
    this.workdir = path.join(__dirname, 'data');
    this.datafile = path.join(this.workdir, 'prepaid.info');
    if (!fs.existsSync(this.workdir)) fs.mkdirSync(this.workdir);
    this.readData();
}

PluginPrepaid.prototype.readData = function() {
    if (fs.existsSync(this.datafile)) {
        this.data = JSON.parse(fs.readFileSync(this.datafile));
    }
}

PluginPrepaid.prototype.writeData = function() {
    fs.writeFile(this.datafile, JSON.stringify(this.data, null, 4), (err) => {
        if (err) console.log(err);
    });
}

PluginPrepaid.prototype.parse = function(queue, data) {
    const re = new RegExp(data.response);
    var match;
    if (match = re.exec(queue.data)) {
        console.log('Prepaid matches: %s', JSON.stringify(match));
        const balanceIndex = data.matches ? data.matches[0] : 1;
        const activeIndex = data.matches ? data.matches[1] : 2;
        const info = {
            response: queue.data,
            balance: match[balanceIndex],
            active: match[activeIndex],
            time: new Date()
        }
        if (!this.data[queue.imsi]) this.data[queue.imsi] = {};
        Object.assign(this.data[queue.imsi], info);
        this.writeData();
        this.formatInfo(info);
        this.appterm.uiCon.emit('prepaid', queue.imsi, info);
    }
}

PluginPrepaid.prototype.formatInfo = function(info) {
    if (typeof info.time == 'string') {
        try {
            const time = new Date(info.time);
            info.time = time;
        }
        catch (e) {
            console.log(e.message);
        }
    }
    if (info.time instanceof Date) {
        info.time = moment(info.time).format('DD MMM YYYY HH:mm');
    }
}

PluginPrepaid.prototype.handle = function(queue) {
    if (queue.type == ACTIVITY_CUSD) {
        const term = this.appterm.get(queue.imsi);
        if (term) {
            const data = this.prepaid[term.info.network.code];
            if (data && data.ussd == queue.address) {
                this.parse(queue, data);
            }
        }
    }
}

PluginPrepaid.prototype.router = function(req, res, next) {
    if (req.method == 'GET') {
        var nr = 0;
        const items = [];
        this.appterm.terminals.forEach((term) => {
            const info = {
                nr: ++nr,
                name: term.name,
                operator: term.info.network.operator
            }
            if (this.data[term.name]) {
                info.response = this.data[term.name].response ? this.data[term.name].response : null;
                info.balance = this.data[term.name].balance ? this.data[term.name].balance : null;
                info.active = this.data[term.name].active ? this.data[term.name].active : null,
                info.time = this.data[term.name].time ? this.data[term.name].time : null;
            }
            this.formatInfo(info);
            items.push(info);
        });
        res.render('prepaid', {items: items});
    }
    if (req.method == 'POST') {
        const result = {success: false}
        switch (req.query.cmd) {
            case 'check':
                const term = this.appterm.get(req.body.imsi);
                if (term) {
                    const data = this.prepaid[term.info.network.code];
                    if (data) {
                        result.success = true;
                        term.addUssdQueue(data.ussd);
                    }
                }
                break;
        }
        res.json(result);
    }
}
