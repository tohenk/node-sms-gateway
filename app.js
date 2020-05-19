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
const Cmd           = require('./lib/cmd');

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
const ntUtil        = require('./lib/util');
const ntLogger      = require('./lib/logger');
const AppTerm       = require('./term');

const database = {
    dialect: 'mysql',
    host: 'localhost',
    username: 'root',
    password: null,
    database: 'smsgw'
}
let config = {};
let configFile;
// read configuration from command line values
if (Cmd.get('config') && fs.existsSync(Cmd.get('config'))) {
    configFile = Cmd.get('config');
} else if (fs.existsSync(path.join(__dirname, 'config.json'))) {
    configFile = path.join(__dirname, 'config.json');
}
if (configFile) {
    console.log('Reading configuration %s', configFile);
    config = JSON.parse(fs.readFileSync(configFile));
}
// check for default configuration
if (!config.database)
    config.database = database;
if (!config.countryCode)
    config.countryCode = '62';
if (!config.operatorFilename)
    config.operatorFilename = path.join(__dirname, 'Operator.ini');
if (!config.configdir)
    config.configdir = path.join(__dirname, 'config');
if (!config.logdir)
    config.logdir = path.join(__dirname, 'logs');
if (!config.secret) {
    config.secret = hashgen();
    console.log('Using secret: %s', config.secret);
}
if (!config.security) config.security = {};
if (!config.security.username) {
    config.security.username = 'admin';
    console.log('Web interface username using default: %s', config.security.username);
}
if (!config.security.password) {
    config.security.password = hashgen();
    console.log('Web interface password generated: %s', config.security.password);
}
if (!config.database.logging) {
    const dblogger = new ntLogger(path.join(config.logdir, 'db.log'));
    config.database.logging = function() {
        dblogger.log.apply(dblogger, Array.from(arguments));
    }
}
config.plugins = Cmd.get('plugins');
// check pools
if (!config.pools) {
    config.pools = [{
        name: 'localhost',
        url: Cmd.get('url') || 'http://localhost:8000',
        key: Cmd.get('key') || ''
    }]
}

AppTerm.init(config).then(() => {
    run();
}).catch((err) => {
    if (err instanceof Error) {
        console.log('%s: %s', err.name, err.message);
    } else {
        console.log(err);
    }
});

function run() {
    const port = Cmd.get('port') | 8080;
    const app = require('./ui/app');
    const http = require('http').Server(app);
    const io = require('socket.io')(http);
    const termio = require('socket.io-client');
    AppTerm.setSocketIo(io);
    AppTerm.setTermIo(termio);
    app.title = 'SMS Gateway';
    app.term = app.locals.term = AppTerm;
    app.authenticate = (username, password) => {
        return username == config.security.username && password == config.security.password ?
            true : false;
    }
    http.listen(port, () => {
        console.log('Application ready on port %s...', port);
    });
}

function hashgen() {
    const shasum = crypto.createHash('sha1');
    shasum.update(ntUtil.formatDate(new Date(), 'yyyyMMddHHmmsszzz') + (Math.random() * 1000000).toString());
    return shasum.digest('hex').substr(0, 8);
}

function usage() {
    console.log('Usage:');
    console.log('  node %s [options]', path.basename(process.argv[1]));
    console.log('');
    console.log('Options:');
    console.log(Cmd.dump());
    console.log('');
    return true;
}