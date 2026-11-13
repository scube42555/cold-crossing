// Stand-in for dist/hot-inspect.js. With HOT_TEST_REAL_DIST set it runs the real one (the page test wants a real plan);
// otherwise it prints an empty answer and its arguments, for the server tests that do not need Node packages.
if (process.env.HOT_TEST_REAL_DIST) {
  await import(`${process.env.HOT_TEST_REAL_DIST}/hot-inspect.js`);
} else {
  process.stdout.write(`${JSON.stringify({ network: process.env.MIDNIGHT_NETWORK, coldPublic: null, snapshot: null, tx: null, argv: process.argv.slice(2) })}\n`);
}
