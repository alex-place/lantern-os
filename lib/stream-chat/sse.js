// SSE response helpers for streaming dream chat.

function writeStreamHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "X-Accel-Buffering": "no",
  });
}

function writeData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendToken(res, token) {
  writeData(res, { type: "token", text: token });
}

function sendError(res, text) {
  writeData(res, { type: "error", text });
}

function sendRoute(res, route) {
  writeData(res, { type: "route", ...route });
}

function sendReceipt(res, receipt) {
  writeData(res, { type: "receipt", ...receipt });
}

function sendDone(res, source, extra = {}) {
  writeData(res, { type: "done", source, ...extra });
  res.end();
}

module.exports = {
  writeStreamHeaders,
  writeData,
  sendToken,
  sendError,
  sendRoute,
  sendReceipt,
  sendDone,
};
