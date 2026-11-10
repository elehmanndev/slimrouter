/** Parse an SSE byte stream into { event, data } records. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | null = null;
  let data: string[] = [];
  const flush = () => {
    const rec = data.length ? { event, data: data.join("\n") } : null;
    event = null;
    data = [];
    return rec;
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        const rec = flush();
        if (rec) yield rec;
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
  }
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  const rec = flush();
  if (rec) yield rec;
}

export function sseLine(data: unknown, event?: string): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : "") + `data: ${payload}\n\n`;
}
