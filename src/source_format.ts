export function preserveSourceFormat(original: Buffer, edited: Buffer): Buffer {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  let before: string, after: string;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    before = decoder.decode(original); after = decoder.decode(edited);
  } catch { return edited; }
  const plain = before.replaceAll("\r\n", ""), crlf = before.includes("\r\n") && !/[\r\n]/.test(plain), lf = before.includes("\n") && !before.includes("\r");
  const sensitive = ["`", "\\\n", "\\\r\n"].some(token => before.includes(token) || after.includes(token));
  if (!sensitive && (crlf || lf) && !after.replaceAll("\r\n", "").includes("\r")) {
    after = after.replaceAll("\r\n", "\n");
    if (crlf) after = after.replaceAll("\n", "\r\n");
  }
  const payload = Buffer.from(after, "utf8");
  return original.subarray(0, 3).equals(bom) ? Buffer.concat([bom, payload]) : payload;
}
