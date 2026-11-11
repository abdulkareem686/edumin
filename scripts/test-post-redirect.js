'use strict';

const postRedirectGet = require('../middleware/postRedirect');

function run(method, ...args) {
    const calls = [];
    const res = {
        redirect: (...recorded) => {
            calls.push(recorded);
            return res;
        }
    };

    postRedirectGet({ method }, res, () => {});
    res.redirect(...args);

    return calls[0];
}

const cases = [
    ['GET', ['/login'], [ '/login' ]],
    ['HEAD', ['/login'], [ '/login' ]],
    ['POST', ['/teacher-dashboard'], [303, '/teacher-dashboard']],
    ['POST', ['/'], [303, '/']],
    ['POST', [302, '/all-students'], [303, '/all-students']],
    ['POST', [301, '/all-students'], [303, '/all-students']],
    ['POST', [307, '/keep'], [307, '/keep']],
    ['POST', [303, '/explicit'], [303, '/explicit']],
    ['GET', [302, '/login'], [302, '/login']]
];

let failed = 0;

for (const [method, input, expected] of cases) {
    const actual = run(method, ...input);
    const pass = JSON.stringify(actual) === JSON.stringify(expected);

    if (!pass) failed += 1;

    console.log(
        (pass ? 'PASS' : 'FAIL').padEnd(5),
        method.padEnd(5),
        JSON.stringify(input).padEnd(28),
        '->',
        JSON.stringify(actual)
    );
}

if (failed) {
    console.error(`${failed} case(s) failed`);
    process.exit(1);
}

console.log('All redirect cases passed.');
