# Node SMS Gateway

## Introduction

Node SMS Gateway is SMS Gateway application which connects to
[Node SMS Terminal](https://github.com/tohenk/node-sms-terminal) and provide
GSM communication queuing such as SMS and USSD. It is also acts as proxy to
other party via its socket communication.

Node SMS Gateway can be extended with other functionality using its plugin
interface.

For example, see included [Prepaid](https://github.com/tohenk/node-sms-gateway-prepaid) plugin.

## Installation

Stand alone installation is available using GIT.

```
$ cd ~
$ git clone https://github.com/tohenk/node-sms-gateway.git
$ cd node-sms-gateway
$ npm install
```

A web interface installation is needed as its now a separate package.

```
$ npm install @ntlab/sms-gateway-ui
```

Install plugins as you need.

```
$ npm install @ntlab/sms-gateway-prepaid
```

To run application (On some Linux distribution replace `node` with `nodejs`)

```
$ node app.js --plugins=@ntlab/sms-gateway-prepaid
```

## Configuration

Node SMS Gateway uses JSON configuration named `config.json` in the working
directory, but it can be told to use configuration elsewhere.

### `database`

Set [Sequelize](http://docs.sequelizejs.com/) database connection parameter.

```json
{
    "database": {
        "dialect": "mysql",
        "host": "localhost",
        "port": 3306,
        "user": "username",
        "password": "password",
        "database": "smsgw",
        "timezone": "Asia/Jakarta"
    }
}
```

### `secret`

Set socket connection secret. Each socket client must send `auth` with secret
and will be checked against this value. If it matches, connection accepted,
otherwise connection will be closed.

```json
{
    "secret": "CHANGEME"
}
```

### `security`

Set web interface username and password. Default username and password is both
`admin`. To secure your instance, it is advised to change default password.

```json
{
    "security": {
        "username": "admin",
        "password": "admin"
    }
}
```

### `pools`

Node SMS Gateway can connects to multiple terminals. Each terminal can be
configured as shown below.

```json
{
    "pools": [
        {
            "name": "localhost",
            "url": "http://localhost:8000",
            "key": "CHANGEME"
        }
    ]
}
```

## Command line options

```
$ node app.js --help
Usage:
  node app.js [options]

Options:
--config=config-file  Read app configuration from file
--url=url, -u=url     Use terminal at URL if no configuration supplied
--key=key, -k=key     Terminal secret key
--port=port, -p=port  Set web server port to listen
--plugins=plugins     Load plugins at start, separate each plugin with comma
```

## Web interface

Node SMS Gateway web interface can be accessed via port `8080` (default) or as
specified by the command line options above.

## Todo

- Socket and web interface currently doesn't support https