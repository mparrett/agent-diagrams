// Board picker: a button naming the open board, and a popover with a filter
// box over the board list. Replaces a native <select>, whose open list can't
// be styled or searched, and long board titles made it unreadable.
//
// Keyboard: Enter, Space or ↓ on the button opens it; typing filters (by
// name or title); ↑/↓ move, Enter opens the board, Esc closes. The filter is
// an ARIA combobox driving a listbox through aria-activedescendant, so focus
// stays in the input while the highlight moves.

const EXAMPLES = "examples/";

/**
 * Mount on `root` (an empty element). `boards` is GET /diagrams' list, already
 * in display order; `current` is the open board's name; `onPick(name)` runs
 * when another board is chosen.
 */
export function mountBoardPicker(root, { boards, current, onPick }) {
  root.classList.add("board-picker");
  root.innerHTML = `
    <button type="button" class="bp-button" aria-haspopup="listbox" aria-expanded="false">
      <span class="bp-name"></span><span class="bp-title"></span><span class="bp-chev" aria-hidden="true"></span>
    </button>
    <div class="bp-pop" hidden>
      <input class="bp-filter" type="text" placeholder="Find a board" autocomplete="off" spellcheck="false"
        role="combobox" aria-autocomplete="list" aria-expanded="true" aria-label="Find a board">
      <ul class="bp-list" role="listbox" aria-label="Boards"></ul>
      <p class="bp-empty" hidden>No board matches</p>
    </div>`;
  const button = root.querySelector(".bp-button");
  const pop = root.querySelector(".bp-pop");
  const filter = root.querySelector(".bp-filter");
  const list = root.querySelector(".bp-list");
  const empty = root.querySelector(".bp-empty");
  const uid = `bp${Math.random().toString(36).slice(2, 8)}`;
  list.id = `${uid}-list`;
  filter.setAttribute("aria-controls", list.id);

  const cur = boards.find((b) => b.name === current) ?? { name: current };
  button.querySelector(".bp-name").textContent = cur.name;
  button.querySelector(".bp-title").textContent = cur.title ?? "";
  button.title = cur.title ? `${cur.name} — ${cur.title}` : cur.name;

  let shown = []; // boards matching the filter, in list order
  let active = -1; // index into `shown`

  function render() {
    const q = filter.value.trim().toLowerCase();
    shown = boards.filter((b) =>
      !q || b.name.toLowerCase().includes(q) ||
      (b.title ?? "").toLowerCase().includes(q)
    );
    list.innerHTML = "";
    let group = null;
    shown.forEach((b, i) => {
      const g = b.name.startsWith(EXAMPLES) ? "Examples" : "Your boards";
      if (g !== group) {
        group = g;
        const h = document.createElement("li");
        h.className = "bp-group";
        h.setAttribute("role", "presentation");
        h.textContent = g;
        list.appendChild(h);
      }
      const li = document.createElement("li");
      li.id = `${uid}-${i}`;
      li.className = "bp-option";
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(b.name === current));
      li.title = b.title ? `${b.name} — ${b.title}` : b.name;
      const name = document.createElement("span");
      name.className = "bp-name";
      name.textContent = b.name;
      li.appendChild(name);
      if (b.title) {
        const t = document.createElement("span");
        t.className = "bp-title";
        t.textContent = b.title;
        li.appendChild(t);
      }
      if (b.readOnly) {
        const ro = document.createElement("span");
        ro.className = "bp-badge";
        ro.textContent = "read-only";
        li.appendChild(ro);
      }
      // mousedown, not click: picking must not blur the filter first.
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        pick(b.name);
      });
      li.addEventListener("mousemove", () => setActive(i, false));
      list.appendChild(li);
    });
    empty.hidden = shown.length > 0;
    const at = shown.findIndex((b) => b.name === current);
    setActive(q ? (shown.length ? 0 : -1) : at, true);
  }

  function setActive(i, scroll) {
    active = i;
    for (const el of list.querySelectorAll(".bp-option")) {
      el.classList.toggle("active", el.id === `${uid}-${i}`);
    }
    if (i < 0) {
      filter.removeAttribute("aria-activedescendant");
      return;
    }
    filter.setAttribute("aria-activedescendant", `${uid}-${i}`);
    if (scroll) {
      document.getElementById(`${uid}-${i}`)?.scrollIntoView({
        block: "nearest",
      });
    }
  }

  function open() {
    if (!pop.hidden) return;
    pop.hidden = false;
    button.setAttribute("aria-expanded", "true");
    filter.value = "";
    render();
    filter.focus();
    document.addEventListener("pointerdown", onOutside, true);
  }

  function close(refocus) {
    if (pop.hidden) return;
    pop.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (refocus) button.focus();
  }

  function onOutside(e) {
    if (!root.contains(e.target)) close(false);
  }

  function pick(name) {
    close(true);
    if (name !== current) onPick(name);
  }

  button.addEventListener("click", () => (pop.hidden ? open() : close(true)));
  button.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      open();
    }
  });
  filter.addEventListener("input", render);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!shown.length) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((active + step + shown.length) % shown.length, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(shown[active].name);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    }
  });
}
