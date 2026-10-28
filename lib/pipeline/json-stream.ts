/**
 * Pulls complete objects out of a JSON array while the JSON is still being
 * written, so each ingredient can be shown (and segmented) as soon as Muse
 * Spark finishes describing it. Feed it deltas in order; it returns the
 * objects that closed in that delta, null for one that did not parse.
 *
 *   {"scene":"fridge","ingredients":[{…},{…},…]}
 *                                    ^ emitted one by one
 */
export class ArrayItemStream {
  private buffer = "";
  private cursor = 0;
  private arrayStart = -1;
  private depth = 0;
  private itemStart = -1;
  private inString = false;
  private escaped = false;
  private done = false;
  /** Objects closed so far, malformed ones included: the index of the one being written. */
  closed = 0;

  constructor(private readonly key: string) {}

  /** The object still being written, as raw text, or null between objects. */
  current(): string | null {
    return this.itemStart >= 0 && !this.done ? this.buffer.slice(this.itemStart) : null;
  }

  push(delta: string): unknown[] {
    const found: unknown[] = [];
    if (this.done) return found;
    this.buffer += delta;

    if (this.arrayStart < 0) {
      // The key comes before any string that could imitate it: the schema puts it right after "scene".
      const match = new RegExp(`"${this.key}"\\s*:\\s*\\[`).exec(this.buffer);
      if (!match) return found;
      this.arrayStart = match.index + match[0].length;
      this.cursor = this.arrayStart;
    }

    for (; this.cursor < this.buffer.length; this.cursor++) {
      const char = this.buffer[this.cursor];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === "\\") this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') {
        this.inString = true;
      } else if (char === "{" || char === "[") {
        if (this.depth === 0 && char === "{") this.itemStart = this.cursor;
        this.depth++;
      } else if (char === "}" || char === "]") {
        if (this.depth === 0) {
          // The array itself closed: nothing more to read.
          this.done = true;
          break;
        }
        this.depth--;
        if (this.depth === 0 && this.itemStart >= 0) {
          try {
            found.push(JSON.parse(this.buffer.slice(this.itemStart, this.cursor + 1)));
          } catch {
            // A malformed item keeps its place as null; the final parse decides what the list holds.
            found.push(null);
          }
          this.itemStart = -1;
          this.closed++;
        }
      }
    }
    return found;
  }
}
