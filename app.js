#!/usr/bin/env node

/**
 * The MIT License (MIT)
 *
 * Copyright (c) 2018-2023 Toha <tohenk@yahoo.com>
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

const path = require('path');
const Cmd = require('@ntlab/ntlib/cmd');

Cmd.addBool('help', 'h', 'Show program usage').setAccessible(false);
Cmd.addVar('config', '', 'Read app configuration from file', 'config-file');
Cmd.addVar('url', 'u', 'Use terminal at URL if no configuration supplied', 'url');
Cmd.addVar('key', 'k', 'Terminal secret key', 'key');
Cmd.addVar('port', 'p', 'Set web server port to listen', 'port');
Cmd.addVar('plugins', '', 'Load plugins at start, separate each plugin with comma', 'plugins');

if (!Cmd.parse() || (Cmd.get('help') && usage())) {
    process.exit();
}

const fs = require('fs');
const Logger = require('@ntlab/ntlib/logger');
const { Work } = require('@ntlab/work');

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
        } else if (fs.existsSync(path.join(process.cwd(), 'config.json'))) {
            filename = path.join(process.cwd(), 'config.json');
        } else if (fs.existsSync(path.join(__dirname, 'config.json'))) {
            filename = path.join(__dirname, 'config.json');
        }
        if (filename) {
            filename = fs.realpathSync(filename);
            console.log('Reading configuration %s', filename);
            this.config = JSON.parse(fs.readFileSync(filename));
        }
        let workdir = this.config.workdir ? this.config.workdir : __dirname;
        // check for default configuration
        if (!this.config.database)
            this.config.database = database;
        if (!this.config.countryCode)
            this.config.countryCode = '62';
        if (!this.config.operatorFilename)
            this.config.operatorFilename = path.join(__dirname, 'Operator.ini');
        if (!this.config.configdir)
            this.config.configdir = path.join(workdir, 'config');
        if (!this.config.datadir)
            this.config.datadir = path.join(workdir, 'data');
        if (!this.config.sessiondir)
            this.config.sessiondir = path.join(workdir, 'sessions');
        if (!this.config.logdir)
            this.config.logdir = path.join(workdir, 'logs');
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
            const dblogger = new Logger(path.join(this.config.logdir, 'db.log'));
            this.config.database.logging = (...args) => {
                dblogger.log.apply(dblogger, args);
            }
        }
        if (!this.config.ui) {
            this.config.ui = '@ntlab/sms-gateway-ui';
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
        const crypto = require('crypto');
        const shasum = crypto.createHash('sha1');
        shasum.update(new Date().toISOString() + (Math.random() * 1000000).toString());
        return shasum.digest('hex').substr(0, 8);
    }

    createTerm() {
        this.term = require('./term');
        return this.term.init(this.config);
    }

    createUI() {
        return new Promise((resolve, reject) => {
            try {
                this.ui = require(this.config.ui)(this.config);
            } catch (err) {
                console.error('Web interface not available: ' + this.config.ui);
            }
            resolve();
        });
    }

    startTerm() {
        return new Promise((resolve, reject) => {
            // create server
            const server = require('http').Server(this.ui ? this.ui : {});
            // create socket.io server
            const opts = {};
            if (this.config.cors) {
                opts.cors = this.config.cors;
            } else {
                opts.cors = {origin: '*'};
            }
            const { Server } = require('socket.io');
            const io = new Server(server, opts);
            const termio = require('socket.io-client');
            this.term.setSocketIo(io);
            this.term.setTermIo(termio);
            // configure ui
            if (this.ui) {
                this.ui.title = 'SMS Gateway';
                this.ui.term = this.ui.locals.term = this.term;
                this.ui.authenticate = (username, password) => {
                    return username == this.config.security.username && password == this.config.security.password ?
                        true : false;
                }
                const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json')));
                this.ui.about = {
                    title: packageInfo.description,
                    version: packageInfo.version,
                    author: packageInfo.author.name ? packageInfo.author.name + ' <' + packageInfo.author.email + '>' : packageInfo.author,
                    license: packageInfo.license
                }
            }
            // start server
            const port = Cmd.get('port') || 8080;
            server.listen(port, () => {
                console.log('Application ready on port %s...', port);
            });
            resolve();
        });
    }

    run() {
        if (this.initialize()) {
            Work.works([
                [w => this.createTerm()],
                [w => this.createUI()],
                [w => this.startTerm()],
            ]);
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