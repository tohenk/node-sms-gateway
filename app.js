#!/usr/bin/env node

/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018-2020 Toha <tohenk@yahoo.com>
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
 * Main App handler.
 */

const path          = require('path');
const Cmd           = require('@ntlab/ntlib/cmd');

Cmd.addBool('help', 'h', 'Show program usage').setAccessible(false);
Cmd.addVar('config', '', 'Read app configuration from file', 'config-file');
Cmd.addVar('url', 'u', 'Use terminal at URL if no configuration supplied', 'url');
Cmd.addVar('key', 'k', 'Terminal secret key', 'key');
Cmd.addVar('port', 'p', 'Set web server port to listen', 'port');
Cmd.addVar('plugins', '', 'Load plugins at start, separate each plugin with comma', 'plugins');

if (!Cmd.parse() || (Cmd.get('help') && usage())) {
    process.exit();
}

const crypto        = require('crypto');
const fs            = require('fs');
const ntUtil        = require('@ntlab/ntlib/util');
const ntLogger      = require('@ntlab/ntlib/logger');

const database = {
    dialect: 'mysql',
    host: 'localhost',
    username: 'root',
    password: null,
    database: 'smsgw'
}

class App {

    config = {}
    term = null

    initialize() {
        let filename;
        // read configuration from command line values
        if (Cmd.get('config') && fs.existsSync(Cmd.get('config'))) {
            filename = Cmd.get('config');
        } else if (fs.existsSync(path.join(__dirname, 'config.json'))) {
            filename = path.join(__dirname, 'config.json');
        }
        if (filename) {
            console.log('Reading configuration %s', filename);
            this.config = JSON.parse(fs.readFileSync(filename));
        }
        // check for default configuration
        if (!this.config.database)
            this.config.database = database;
        if (!this.config.countryCode)
            this.config.countryCode = '62';
        if (!this.config.operatorFilename)
            this.config.operatorFilename = path.join(__dirname, 'Operator.ini');
        if (!this.config.configdir)
            this.config.configdir = path.join(__dirname, 'config');
        if (!this.config.logdir)
            this.config.logdir = path.join(__dirname, 'logs');
        if (!this.config.secret) {
            this.config.secret = this.hashgen();
            console.log('Using secret: %s', this.config.secret);
        }
        if (!this.config.security) this.config.security = {};
        if (!this.config.security.username) {
            this.config.security.username = 'admin';
            console.log('Web interface username using default: %s', this.config.security.username);
        }
        if (!this.config.security.password) {
            this.config.security.password = this.hashgen();
            console.log('Web interface password generated: %s', this.config.security.password);
        }
        if (!this.config.database.logging) {
            const dblogger = new ntLogger(path.join(this.config.logdir, 'db.log'));
            this.config.database.logging = (...args) => {
                dblogger.log.apply(dblogger, args);
            }
        }
        this.config.plugins = Cmd.get('plugins');
        // check pools
        if (!this.config.pools) {
            this.config.pools = [{
                name: 'localhost',
                url: Cmd.get('url') || 'http://localhost:8000',
                key: Cmd.get('key') || ''
            }];
        }
        return true;
    }

    hashgen() {
        const shasum = crypto.createHash('sha1');
        shasum.update(ntUtil.formatDate(new Date(), 'yyyyMMddHHmmsszzz') + (Math.random() * 1000000).toString());
        return shasum.digest('hex').substr(0, 8);
    }

    createTerm(callback) {
        this.term = require('./term');
        this.term.init(this.config)
            .then(() => {
                callback();
            })
            .catch((err) => {
                if (err instanceof Error) {
                    console.log('%s: %s', err.name, err.message);
                } else {
                    console.log(err);
                }
            })
        ;
    }

    startTerm() {
        const port = Cmd.get('port') || 8080;
        const app = require('./ui/app');
        const http = require('http').Server(app);
        const opts = {};
        if (this.config.cors) {
            opts.cors = this.config.cors;
        } else {
            opts.cors = {origin: '*'};
        }
        const io = require('socket.io')(http, opts);
        const termio = require('socket.io-client');
        this.term.setSocketIo(io);
        this.term.setTermIo(termio);
        app.title = 'SMS Gateway';
        app.term = app.locals.term = this.term;
        app.authenticate = (username, password) => {
            return username == this.config.security.username && password == this.config.security.password ?
                true : false;
        }
        http.listen(port, () => {
            console.log('Application ready on port %s...', port);
        });
    }

    run() {
        if (this.initialize()) {
            this.createTerm(() => {
                this.startTerm();
            });
        }
    }
}

(function run() {
    new App().run();
})();

function usage() {
    console.log('Usage:');
    console.log('  node %s [options]', path.basename(process.argv[1]));
    console.log('');
    console.log('Options:');
    console.log(Cmd.dump());
    console.log('');
    return true;
}