export type Yaml =
  | string
  | number
  | boolean
  | null
  | Yaml[]
  | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string;
}

export function parseYaml(input: string): { [key: string]: Yaml } {
  const lines = tokenize(input);
  const parsed = parseBlock(lines, 0, 0);
  if (parsed.next !== lines.length) {
    throw new Error(`YAML parse stopped early at line text: ${lines[parsed.next]?.text ?? ""}`);
  }
  if (parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    throw new Error("YAML root must be a map");
  }
  return parsed.value;
}

function tokenize(input: string): Line[] {
  const lines: Line[] = [];
  for (const raw of input.split(/\r?\n/)) {
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue;
    const match = /^( *)(.*)$/.exec(raw);
    if (!match) continue;
    lines.push({ indent: match[1].length, text: match[2].trimEnd() });
  }
  return lines;
}

function parseBlock(lines: Line[], start: number, indent: number): { value: Yaml; next: number } {
  if (start >= lines.length || lines[start].indent < indent) {
    return { value: {}, next: start };
  }
  if (lines[start].text.startsWith("- ")) {
    return parseList(lines, start, indent);
  }
  const obj: { [key: string]: Yaml } = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const text = lines[index].text;
    const colon = text.indexOf(":");
    if (colon <= 0) throw new Error(`Expected key: value, got ${text}`);
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();
    if (rest === "") {
      const nested = parseBlock(lines, index + 1, indent + 2);
      obj[key] = nested.value;
      index = nested.next;
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      obj[key] = parseInlineList(rest);
      index += 1;
    } else {
      obj[key] = parseScalar(rest);
      index += 1;
    }
  }
  return { value: obj, next: index };
}

function parseList(lines: Line[], start: number, indent: number): { value: Yaml[]; next: number } {
  const items: Yaml[] = [];
  let index = start;
  while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
    const itemText = lines[index].text.slice(2).trim();
    const colon = itemText.indexOf(":");
    if (colon === -1) {
      items.push(parseScalar(itemText));
      index += 1;
      continue;
    }
    const key = itemText.slice(0, colon).trim();
    const rest = itemText.slice(colon + 1).trim();
    const map: { [key: string]: Yaml } = {};
    if (rest === "") {
      const nested = parseBlock(lines, index + 1, indent + 2);
      map[key] = nested.value;
      index = nested.next;
    } else {
      map[key] = rest.startsWith("[") && rest.endsWith("]") ? parseInlineList(rest) : parseScalar(rest);
      index += 1;
      if (index < lines.length && lines[index].indent >= indent + 2 && !lines[index].text.startsWith("- ")) {
        const nested = parseBlock(lines, index, indent + 2);
        if (nested.value && typeof nested.value === "object" && !Array.isArray(nested.value)) {
          Object.assign(map, nested.value);
        }
        index = nested.next;
      }
    }
    items.push(map);
  }
  return { value: items, next: index };
}

function parseInlineList(text: string): Yaml[] {
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => parseScalar(part.trim()));
}

function parseScalar(text: string): Yaml {
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}
