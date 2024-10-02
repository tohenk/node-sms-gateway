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

const path = require('path');
const Work = require('@ntlab/work/work');
const SequelizeManager = require('@ntlab/sequelize-manager');
const { Op, QueryTypes } = require('@sequelize/core');

/**
 * App storage.
 */
class AppStorage {

    ACTIVITY_CALL = 1
    ACTIVITY_RING = 2
    ACTIVITY_SMS = 3
    ACTIVITY_INBOX = 4
    ACTIVITY_USSD = 5
    ACTIVITY_CUSD = 6

    PRIORITY_ABOVE = 10
    PRIORITY_NORMAL = 20
    PRIORITY_BELOW = 50

    Op = Op

    init(options) {
        this.manager = new SequelizeManager({modeldir: path.join(__dirname, 'model'), modelStore: this});
        return Work.works([
            [w => this.manager.init(options)],
            [w => this.manager.connectDatabase()],
            [w => this.manager.syncModels()],
            [w => Promise.resolve(this.db = this.manager.getSequelize())],
        ]);
    }

    saveQueue(origin, queue, done) {
        const cb = result => {
            if (typeof done === 'function') {
                done(result);
            }
        }
        this.GwQueue.count({where: {imsi: origin, hash: queue.hash}})
            .then(count => {
                if (count === 0) {
                    queue.imsi = origin;
                    queue.processed = false;
                    queue.status = 0;
                    if (!queue.priority) {
                        queue.priority = this.PRIORITY_NORMAL;
                    }
                    if (!queue.time) {
                        queue.time = new Date();
                    }
                    this.GwQueue.create(queue)
                        .then(result => cb(result))
                        .catch(err => {
                            console.error(err);
                            cb();
                        })
                    ;
                } else {
                    cb();
                }
            })
            .catch(err => {
                console.error(err);
                cb();
            })
        ;
    }

    saveLog(origin, log, done) {
        this.GwLog.count({where: {imsi: origin, hash: log.hash, type: log.type}})
            .then(count => {
                if (count === 0) {
                    this.GwLog.create({
                        imsi: origin,
                        hash: log.hash,
                        type: log.type,
                        address: log.address,
                        data: log.data,
                        status: log.status,
                        time: log.time
                    })
                        .then(result => {
                            if (typeof done === 'function') {
                                done(result);
                            }
                        })
                    ;
                }
            })
            .catch(err => {
                console.error(err);
            })
        ;
    }

    updateReport(origin, report, done) {
        const condition = {imsi: origin, hash: report.hash, type: this.ACTIVITY_SMS};
        this.GwLog.count({where: condition})
            .then(count => {
                if (count === 1) {
                    this.GwLog.findOne({where: condition})
                        .then(GwLog => {
                            GwLog.update({
                                code: report.code,
                                sent: report.sent,
                                received: report.received
                            })
                                .then(GwLog => {
                                    if (typeof done === 'function') {
                                        done(GwLog);
                                    }
                                })
                            ;
                        })
                    ;
                }
            })
            .catch(err => {
                console.error(err);
            })
        ;
    }

    countStats(imsi) {
        const table = 'gw_queue';
        const sql = `SELECT 1 AS 'type', COUNT(*) AS count FROM ${table}
WHERE imsi = ? AND type IN (${this.ACTIVITY_CALL}, ${this.ACTIVITY_SMS}, ${this.ACTIVITY_USSD}) AND processed = 1 AND status = 0
UNION
SELECT 2 AS 'type', COUNT(*) AS count FROM ${table}
WHERE imsi = ? AND type IN (${this.ACTIVITY_CALL}, ${this.ACTIVITY_SMS}, ${this.ACTIVITY_USSD}) AND processed = 1 AND status = 1
`;
        return this.db.query(sql, {type: QueryTypes.SELECT, replacements: [imsi, imsi]});
    }

    countRecents() {
        const table = 'gw_queue';
        const sql = `SELECT COUNT(a.id) AS count FROM ${table} AS a
INNER JOIN (
    SELECT address, MAX(id) AS id, MAX(time) AS time
    FROM ${table}
    WHERE type IN (${this.ACTIVITY_SMS}, ${this.ACTIVITY_INBOX})
    GROUP BY address
) AS b ON a.id = b.id`;
        return this.db.query(sql, {type: QueryTypes.SELECT});
    }

    getRecents(offset, limit) {
        const table = 'gw_queue';
        const sql = `SELECT a.* FROM ${table} AS a
INNER JOIN (
    SELECT address, MAX(id) AS id, MAX(time) AS time
    FROM ${table}
    WHERE type IN (${this.ACTIVITY_SMS}, ${this.ACTIVITY_INBOX})
    GROUP BY address
) AS b ON a.id = b.id
ORDER BY a.time DESC LIMIT ?, ?`;
        return this.db.query(sql, {replacements: [offset, limit], type: QueryTypes.SELECT,
            model: this.GwQueue});
    }
}

module.exports = new AppStorage();