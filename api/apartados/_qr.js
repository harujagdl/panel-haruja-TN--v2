import fs from "fs";
import path from "path";
import vm from "vm";

let qrFactory = null;

function loadQrFactory() {
  if (qrFactory) return qrFactory;
  const scriptPath = path.join(process.cwd(), "app", "assets", "qrcode.min.js");
  const source = fs.readFileSync(scriptPath, "utf8");
  const sandbox = { global: {}, window: {}, self: {}, console };
  sandbox.global = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(source, sandbox);
  qrFactory = sandbox.qrcode;
  return qrFactory;
}

export function buildQrSvg(text) {
  if (!text) return "";
  try {
    const factory = loadQrFactory();
    if (!factory) return "";
    const qr = factory(0, "M");
    qr.addData(String(text));
    qr.make();
    return qr.createSvgTag({ margin: 2, scalable: false });
  } catch (_error) {
    return "";
  }
}
