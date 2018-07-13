const path  = require('path');
const express = require('express');
const router  = express.Router();

router.all('/p/:plugin', function(req, res, next) {
    if (req.params.plugin) {
        const term = req.app.term;
        var plugin;
        term.plugins.forEach((p) => {
            if (p.name == req.params.plugin) {
                plugin = p;
                return true;
            }
        });
        if (plugin) {
            res.locals.viewdir = path.join(path.dirname(plugin.src), 'views');
            return plugin.router(req, res, next);
        } else {
            res.sendStatus(404);
        }
    } else {
        next();
    }
});

module.exports = router;
