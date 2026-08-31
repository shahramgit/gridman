const COPY = 'copy';
const CUT = 'cut';

class BrunoClipboard {
  constructor() {
    this.items = [];
    this.operation = COPY;
  }

  /**
   * @param {Object} item - Item to copy
   * @param {'copy'|'cut'} operation - Whether a paste should duplicate or move
   */
  write(item, operation = COPY) {
    // Limit to one item for now
    this.items = [item];
    this.operation = operation === CUT ? CUT : COPY;
  }

  /**
   * @returns {Object} Result with items array
   */
  read() {
    return {
      items: this.items,
      operation: this.operation,
      hasData: this.items.length > 0
    };
  }

  /**
   * A cut is consumed by its paste: leaving it armed means the next paste
   * tries to move a path that is no longer there.
   */
  clear() {
    this.items = [];
    this.operation = COPY;
  }
}

const brunoClipboard = new BrunoClipboard();

export default brunoClipboard;
export { COPY, CUT };
