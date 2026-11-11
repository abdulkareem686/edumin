'use strict';

/**
 * POST -> Redirect -> GET.
 *
 * `res.redirect()` answers with 302 by default. Behind Vercel's rewrite layer a
 * 302 is turned into a 307 for every path except `/`, and a 307 tells the
 * browser to repeat the original request - method and body included.
 *
 * That breaks every form in the app: after `POST /login` the browser re-sends
 * the login form to `/`, `/teacher-dashboard`, `/student-dashboard` or
 * `/parent/parent-dashboard`. Those URLs only have GET handlers, so the retried
 * POST fell through to the catch-all and rendered "Page Not Found" before the
 * user clicked anything.
 *
 * 303 ("See Other") is the correct status here: it tells the browser to fetch
 * the redirect target with GET, so the page renders on the first try no matter
 * what the platform does with a 302.
 */
module.exports = function postRedirectGet(req, res, next) {

    const redirect = res.redirect.bind(res);

    res.redirect = function (statusOrUrl, url) {

        const method = String(req.method || 'GET').toUpperCase();
        const isRead = method === 'GET' || method === 'HEAD';

        // res.redirect(url)
        if (typeof statusOrUrl === 'string') {
            return isRead
                ? redirect(statusOrUrl)
                : redirect(303, statusOrUrl);
        }

        // res.redirect(status, url)
        const status = Number(statusOrUrl);

        // 301/302 are ambiguous for non-GET requests; 303 is not.
        if (!isRead && (status === 301 || status === 302)) {
            return redirect(303, url);
        }

        return redirect(statusOrUrl, url);
    };

    next();
};
