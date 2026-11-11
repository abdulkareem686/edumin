'use strict';

const app = require('../server');

module.exports = async function handler(req, res) {
    try {
        await app.locals.ready();
        return app(req, res);
    } catch (error) {
        console.error('Application initialization failed:', error);
        if (!res.headersSent) {
            res.status(503).send('Service unavailable');
        }
    }
};
