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
 * Log sample plugin.
 */

module.exports = exports = PluginLog;

const ACTIVITY_CALL = 1;
const ACTIVITY_RING = 2;
const ACTIVITY_SMS = 3;
const ACTIVITY_INBOX = 4;
const ACTIVITY_USSD = 5;
const ACTIVITY_CUSD = 6;

function PluginLog(appterm) {
    this.name = 'log';
    this.description = 'Sample log plugin';
    this.appterm = appterm;
}

PluginLog.prototype.handle = function(queue) {
    switch (queue.type) {
        case ACTIVITY_RING:
            console.log('LOG: incoming call from %s', queue.address);
            break;
        case ACTIVITY_INBOX:
            console.log('LOG: incoming message from %s <- %s', queue.address, queue.data);
            break;
        case ACTIVITY_CUSD:
            console.log('LOG: incoming USSD %s <- %s', queue.address, queue.data);
            break;
    }
    queue.veto = true;
}