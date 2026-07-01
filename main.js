const {
  ItemView,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  normalizePath,
  parseYaml,
  setIcon,
  stringifyYaml,
} = require("obsidian");

const VIEW_TYPE = "raremode-week-board";
const TASKS_FOLDER = "TaskNotes/Tasks";
const PROJECTS_FOLDER = "TaskNotes/Projects";
const PROJECTS = ["RareMod", "Личное", "Parfume", "Traker"];
const NO_PROJECT = "Без проекта";

module.exports = class RareModeWeekBoardPlugin extends Plugin {
  async onload() {
    this.registerView(VIEW_TYPE, (leaf) => new WeekBoardView(leaf, this));
    this.registerInterval(window.setInterval(() => this.runAutoRollover(), 5 * 60 * 1000));

    this.addRibbonIcon("calendar-check", "RareMode Week Board", () => {
      this.openBoard();
    });

    this.addCommand({
      id: "open-raremode-week-board",
      name: "Open RareMode Week Board",
      callback: () => this.openBoard(),
    });

    this.addCommand({
      id: "create-task-for-today",
      name: "Create TaskNotes task for today",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.openBoard();
        return true;
      },
    });

    window.setTimeout(() => this.runAutoRollover(), 5000);
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async openBoard() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }

  async runAutoRollover() {
    const now = new Date();
    const dates = [addDays(now, -1)];
    if (now.getHours() >= 23) dates.push(now);

    for (const sourceDate of dates) {
      await this.rolloverDate(toDateKey(sourceDate));
    }
  }

  async rolloverDate(sourceDate) {
    const targetDate = toDateKey(addDays(fromDateKey(sourceDate), 1));
    const tasks = await readAllTaskNotes(this.app);
    const candidates = tasks.filter(
      (task) => task.scheduled === sourceDate && task.project === "RareMod" && task.rollover
    );

    for (const task of candidates) {
      const exists = tasks.some(
        (other) =>
          other.scheduled === targetDate &&
          other.project === "RareMod" &&
          other.title.trim().toLowerCase() === task.title.trim().toLowerCase()
      );
      if (exists) continue;
      await createTaskNote(this.app, task.title, targetDate, "RareMod", {
        priority: task.priority || "none",
        rollover: true,
      });
      new Notice(`Rolled over to tomorrow: ${task.title}`);
    }
  }
};

class WeekBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.weekStart = startOfWeek(new Date());
    this.selectedDate = new Date();
    this.draggedPath = null;
    this.refreshTimer = null;
    this.touchDrag = null;
    this.suppressClickUntil = 0;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "RareMode Week";
  }

  getIcon() {
    return "calendar-check";
  }

  async onOpen() {
    this.registerVaultEvents();
    await this.render();
  }

  async onClose() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
  }

  registerVaultEvents() {
    const refresh = () => {
      if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => this.render(), 250);
    };
    this.registerEvent(this.app.vault.on("create", refresh));
    this.registerEvent(this.app.vault.on("modify", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
  }

  async render() {
    const root = this.contentEl;
    root.empty();
    root.addClass("rm-week-board");

    this.renderToolbar(root);

    const tasks = await this.readTasks();
    const dates = Platform.isMobile
      ? [this.selectedDate]
      : Array.from({ length: 7 }, (_, index) => addDays(this.weekStart, index));
    const board = root.createDiv({ cls: "rm-board-grid" });
    board.toggleClass("is-mobile-day", Platform.isMobile);

    for (const date of dates) {
      this.renderDay(board, date, tasks.filter((task) => task.scheduled === toDateKey(date)));
    }

    if (Platform.isMobile) this.renderMobileDropZones(root);
  }

  renderToolbar(root) {
    const toolbar = root.createDiv({ cls: "rm-toolbar" });
    const left = toolbar.createDiv({ cls: "rm-toolbar__nav" });

    const prev = left.createEl("button", {
      cls: "rm-icon-button",
      attr: { "aria-label": Platform.isMobile ? "Предыдущий день" : "Предыдущая неделя" },
    });
    setIcon(prev, "chevron-left");
    prev.onclick = async () => {
      if (Platform.isMobile) this.selectedDate = addDays(this.selectedDate, -1);
      else this.weekStart = addDays(this.weekStart, -7);
      await this.render();
    };

    const today = left.createEl("button", { cls: "rm-text-button", text: "Сегодня" });
    today.onclick = async () => {
      this.selectedDate = new Date();
      this.weekStart = startOfWeek(new Date());
      await this.render();
    };

    const next = left.createEl("button", {
      cls: "rm-icon-button",
      attr: { "aria-label": Platform.isMobile ? "Следующий день" : "Следующая неделя" },
    });
    setIcon(next, "chevron-right");
    next.onclick = async () => {
      if (Platform.isMobile) this.selectedDate = addDays(this.selectedDate, 1);
      else this.weekStart = addDays(this.weekStart, 7);
      await this.render();
    };

    const title = toolbar.createDiv({ cls: "rm-toolbar__title" });
    title.textContent = Platform.isMobile
      ? formatLongDate(this.selectedDate)
      : `${formatShortDate(this.weekStart)} - ${formatShortDate(addDays(this.weekStart, 6))}`;

    const reload = toolbar.createEl("button", { cls: "rm-icon-button", attr: { "aria-label": "Refresh" } });
    setIcon(reload, "refresh-cw");
    reload.onclick = () => this.render();
  }

  renderDay(board, date, dayTasks) {
    const dateKey = toDateKey(date);
    const day = board.createDiv({ cls: "rm-day" });
    day.toggleClass("is-today", dateKey === toDateKey(new Date()));

    const header = day.createDiv({ cls: "rm-day__header" });
    header.createDiv({ cls: "rm-day__name", text: formatWeekday(date) });
    header.createDiv({ cls: "rm-day__date", text: formatShortDate(date) });

    for (const project of [...PROJECTS, NO_PROJECT]) {
      const groupTasks = dayTasks.filter((task) => task.project === project);
      this.renderProjectGroup(day, dateKey, project, groupTasks);
    }
  }

  renderProjectGroup(day, dateKey, project, tasks) {
    const group = day.createDiv({ cls: "rm-project-group" });
    group.dataset.project = project;
    group.dataset.date = dateKey;

    const head = group.createDiv({ cls: "rm-project-group__head" });
    head.createSpan({ cls: `rm-project-dot rm-project-dot--${projectClass(project)}` });
    head.createSpan({ cls: "rm-project-title", text: project });
    head.createSpan({ cls: "rm-project-count", text: String(tasks.length) });

    const list = group.createDiv({ cls: "rm-task-list" });
    list.ondragover = (event) => {
      event.preventDefault();
      group.addClass("is-drop-target");
    };
    list.ondragleave = () => group.removeClass("is-drop-target");
    list.ondrop = async (event) => {
      event.preventDefault();
      group.removeClass("is-drop-target");
      if (this.draggedPath) {
        await this.moveTask(this.draggedPath, dateKey, project);
        this.draggedPath = null;
      }
    };

    for (const task of tasks.sort(taskSort)) {
      this.renderTask(list, task);
    }

    const input = group.createEl("input", {
      cls: "rm-new-task",
      attr: {
        type: "text",
        placeholder: "Добавить задачу",
        "aria-label": `Добавить задачу: ${project}, ${dateKey}`,
      },
    });
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return;
      const title = input.value.trim();
      if (!title) return;
      input.value = "";
      await this.createTask(title, dateKey, project);
    });
  }

  renderTask(list, task) {
    const card = list.createDiv({ cls: "rm-task", attr: { draggable: "true" } });
    card.dataset.path = task.path;
    card.toggleClass("is-done", task.done);
    card.ondragstart = () => {
      this.draggedPath = task.path;
      card.addClass("is-dragging");
    };
    card.ondragend = () => {
      this.draggedPath = null;
      card.removeClass("is-dragging");
    };
    if (Platform.isMobile) this.registerTouchDrag(card, task);

    const checkbox = card.createEl("input", {
      cls: "rm-task__check",
      attr: { type: "checkbox", "aria-label": `Выполнить: ${task.title}` },
    });
    checkbox.checked = task.done;
    checkbox.onchange = async () => {
      await this.setTaskDone(task.path, checkbox.checked);
    };

    const title = card.createDiv({ cls: "rm-task__title", text: task.title });
    title.onclick = () => {
      if (Date.now() < this.suppressClickUntil) return;
      this.openTask(task.path);
    };
  }

  renderMobileDropZones(root) {
    const zones = root.createDiv({ cls: "rm-mobile-drop-zones", attr: { "aria-hidden": "true" } });
    const previous = zones.createDiv({ cls: "rm-mobile-drop-zone is-previous" });
    setIcon(previous.createSpan({ cls: "rm-mobile-drop-zone__icon" }), "chevron-left");
    previous.createSpan({ text: "На день назад" });
    const next = zones.createDiv({ cls: "rm-mobile-drop-zone is-next" });
    next.createSpan({ text: "На день вперед" });
    setIcon(next.createSpan({ cls: "rm-mobile-drop-zone__icon" }), "chevron-right");
  }

  registerTouchDrag(card, task) {
    let holdTimer = null;
    let startX = 0;
    let startY = 0;
    let active = false;

    const reset = () => {
      if (holdTimer) window.clearTimeout(holdTimer);
      holdTimer = null;
      active = false;
      card.style.removeProperty("transform");
      card.removeClass("is-touch-dragging");
      this.contentEl.removeClass("is-touch-dragging");
      this.touchDrag = null;
    };

    card.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" || event.target.closest("input, button")) return;
      startX = event.clientX;
      startY = event.clientY;
      holdTimer = window.setTimeout(() => {
        active = true;
        this.touchDrag = task;
        card.addClass("is-touch-dragging");
        this.contentEl.addClass("is-touch-dragging");
        if (navigator.vibrate) navigator.vibrate(20);
      }, 320);
    });

    card.addEventListener(
      "pointermove",
      (event) => {
        const dx = event.clientX - startX;
        const dy = event.clientY - startY;
        if (!active && Math.hypot(dx, dy) > 10) {
          if (holdTimer) window.clearTimeout(holdTimer);
          holdTimer = null;
          return;
        }
        if (!active) return;
        event.preventDefault();
        card.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        this.updateMobileDropTarget(event.clientX);
      },
      { passive: false }
    );

    const finish = async (event) => {
      if (!active) {
        reset();
        return;
      }
      event.preventDefault();
      const direction = this.mobileDropDirection(event.clientX);
      this.suppressClickUntil = Date.now() + 500;
      reset();
      if (!direction) return;
      const targetDate = addDays(fromDateKey(task.scheduled), direction);
      await this.moveTask(task.path, toDateKey(targetDate), task.project);
      this.selectedDate = targetDate;
      new Notice(direction < 0 ? "Задача перенесена на день назад" : "Задача перенесена на день вперед");
      await this.render();
    };

    card.addEventListener("pointerup", finish);
    card.addEventListener("pointercancel", reset);
  }

  mobileDropDirection(clientX) {
    const width = window.innerWidth;
    if (clientX <= width * 0.38) return -1;
    if (clientX >= width * 0.62) return 1;
    return 0;
  }

  updateMobileDropTarget(clientX) {
    const direction = this.mobileDropDirection(clientX);
    const zones = this.contentEl.querySelectorAll(".rm-mobile-drop-zone");
    zones.forEach((zone) => zone.removeClass("is-active"));
    if (direction < 0) this.contentEl.querySelector(".rm-mobile-drop-zone.is-previous")?.addClass("is-active");
    if (direction > 0) this.contentEl.querySelector(".rm-mobile-drop-zone.is-next")?.addClass("is-active");
  }

  async readTasks() {
    const tasks = [];
    for (const file of taskNoteFiles(this.app)) {
      const fm = await readTaskFrontmatter(this.app, file);
      if (!isTaskFrontmatter(fm)) continue;

      const scheduled = normalizeDate(fm.scheduled);
      if (!scheduled) continue;

      tasks.push({
        path: file.path,
        title: cleanTitle(fm.title || file.basename),
        scheduled,
        project: normalizeProject(fm.projects),
        status: String(fm.status || "open"),
        done: String(fm.status || "open") === "done",
        rollover: fm.rollover === true || String(fm.rollover || "").toLowerCase() === "true",
        priority: String(fm.priority || "none"),
        modified: file.stat.mtime,
      });
    }
    return tasks;
  }

  async createTask(title, scheduled, project) {
    const filename = await this.nextTaskPath(title);
    const now = new Date().toISOString();
    const fm = {
      status: "open",
      priority: "none",
      scheduled,
      dateCreated: now,
      dateModified: now,
      tags: ["task"],
    };
    if (project !== NO_PROJECT) {
      fm.projects = [`[[${PROJECTS_FOLDER}/${project}|${project}]]`];
    }
    const content = `---\n${stringifyYaml(fm)}---\n\n`;
    await this.app.vault.create(filename, content);
    new Notice(`Задача добавлена: ${title}`);
  }

  async nextTaskPath(title) {
    const base = sanitizeFilename(title) || "Новая задача";
    let path = normalizePath(`${TASKS_FOLDER}/${base}.md`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${TASKS_FOLDER}/${base}-${index}.md`);
      index += 1;
    }
    return path;
  }

  async setTaskDone(path, done) {
    await this.updateTaskFrontmatter(path, (fm) => {
      fm.status = done ? "done" : "open";
      fm.dateModified = new Date().toISOString();
      if (done) fm.completedDate = toDateKey(new Date());
      else delete fm.completedDate;
      return fm;
    });
  }

  async setTaskRollover(path, rollover) {
    await this.updateTaskFrontmatter(path, (fm) => {
      if (rollover) fm.rollover = true;
      else delete fm.rollover;
      fm.dateModified = new Date().toISOString();
      return fm;
    });
  }

  async moveTask(path, scheduled, project) {
    await this.updateTaskFrontmatter(path, (fm) => {
      fm.scheduled = scheduled;
      fm.dateModified = new Date().toISOString();
      if (project === NO_PROJECT) delete fm.projects;
      else fm.projects = [`[[${PROJECTS_FOLDER}/${project}|${project}]]`];
      return fm;
    });
  }

  async updateTaskFrontmatter(path, updater) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    await this.app.vault.process(file, (content) => {
      const parsed = splitFrontmatter(content);
      const fm = updater(parsed.frontmatter);
      return `---\n${stringifyYaml(fm)}---\n${parsed.body}`;
    });
  }

  async openTask(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(true).openFile(file);
    }
  }
}

async function readAllTaskNotes(app) {
  const tasks = [];
  for (const file of taskNoteFiles(app)) {
    const fm = await readTaskFrontmatter(app, file);
    if (!isTaskFrontmatter(fm)) continue;

    const scheduled = normalizeDate(fm.scheduled);
    if (!scheduled) continue;

    tasks.push({
      path: file.path,
      title: cleanTitle(fm.title || file.basename),
      scheduled,
      project: normalizeProject(fm.projects),
      status: String(fm.status || "open"),
      done: String(fm.status || "open") === "done",
      rollover: fm.rollover === true || String(fm.rollover || "").toLowerCase() === "true",
      priority: String(fm.priority || "none"),
      modified: file.stat.mtime,
    });
  }
  return tasks;
}

function taskNoteFiles(app) {
  const folderPrefix = `${TASKS_FOLDER}/`;
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.path === TASKS_FOLDER || file.path.startsWith(folderPrefix));
}

async function readTaskFrontmatter(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  if (cache?.frontmatter) return cache.frontmatter;

  const content = await app.vault.cachedRead(file);
  return splitFrontmatter(content).frontmatter;
}

async function createTaskNote(app, title, scheduled, project, options = {}) {
  const filename = await nextTaskPath(app, title);
  const now = new Date().toISOString();
  const fm = {
    status: "open",
    priority: options.priority || "none",
    scheduled,
    dateCreated: now,
    dateModified: now,
    tags: ["task"],
  };
  if (project !== NO_PROJECT) {
    fm.projects = [`[[${PROJECTS_FOLDER}/${project}|${project}]]`];
  }
  if (options.rollover) fm.rollover = true;
  const content = `---\n${stringifyYaml(fm)}---\n\n`;
  await app.vault.create(filename, content);
}

async function nextTaskPath(app, title) {
  const base = sanitizeFilename(title) || "New task";
  let path = normalizePath(`${TASKS_FOLDER}/${base}.md`);
  let index = 2;
  while (app.vault.getAbstractFileByPath(path)) {
    path = normalizePath(`${TASKS_FOLDER}/${base}-${index}.md`);
    index += 1;
  }
  return path;
}

function splitFrontmatter(content) {
  if (!content.startsWith("---")) return { frontmatter: {}, body: `\n${content}` };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: `\n${content}` };
  const raw = content.slice(3, end).trim();
  const bodyStart = content.indexOf("\n", end + 4);
  const body = bodyStart === -1 ? "\n" : content.slice(bodyStart);
  let frontmatter = {};
  try {
    frontmatter = parseYaml(raw) || {};
  } catch (error) {
    console.error("RareMode Week Board: failed to parse frontmatter", error);
  }
  return { frontmatter, body };
}

function isTaskFrontmatter(fm) {
  const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? [fm.tags] : [];
  return tags.map((tag) => String(tag).replace(/^#/, "")).includes("task");
}

function normalizeDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function normalizeProject(projects) {
  const list = Array.isArray(projects) ? projects : projects ? [projects] : [];
  const labels = list.map((project) => projectLabel(project)).filter(Boolean);
  return PROJECTS.find((project) => labels.includes(project)) || NO_PROJECT;
}

function projectLabel(project) {
  const value = String(project || "").trim();
  const alias = value.match(/\[\[[^\]|]+?\|([^\]]+)\]\]/);
  if (alias) return alias[1].trim();
  const link = value.match(/\[\[([^\]]+)\]\]/);
  if (link) return basenameNoExt(link[1]);
  return basenameNoExt(value);
}

function basenameNoExt(value) {
  return String(value || "")
    .split("/")
    .pop()
    .replace(/\.md$/i, "")
    .trim();
}

function cleanTitle(title) {
  return String(title || "").trim() || "Без названия";
}

function sanitizeFilename(title) {
  return cleanTitle(title)
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function startOfWeek(date) {
  const result = new Date(date);
  const day = result.getDay() || 7;
  result.setHours(0, 0, 0, 0);
  result.setDate(result.getDate() - day + 1);
  return result;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function fromDateKey(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(date);
}

function formatWeekday(date) {
  return new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  })
    .format(date)
    .replace(".", "");
}

function projectClass(project) {
  if (project === "RareMod") return "rare";
  if (project === "Личное") return "personal";
  if (project === "Parfume") return "parfume";
  if (project === "Traker") return "traker";
  return "none";
}

function taskSort(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  return a.title.localeCompare(b.title, "ru");
}
