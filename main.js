const {
  ItemView,
  MarkdownView,
  Modal,
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
const DEFAULT_PROJECTS = ["RareMod", "Личное", "Parfume", "Traker"];
const NO_PROJECT = "Без проекта";
const PROJECT_COLORS = [
  { name: "Вишнёвый", value: "#9b1c31" },
  { name: "Зелёный", value: "#22c55e" },
  { name: "Голубой", value: "#60a5fa" },
  { name: "Янтарный", value: "#f59e0b" },
  { name: "Фиолетовый", value: "#a78bfa" },
  { name: "Бирюзовый", value: "#14b8a6" },
  { name: "Розовый", value: "#ec4899" },
  { name: "Оранжевый", value: "#f97316" },
];

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
    this.cancelTouchDrag();
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

    const projects = await this.readProjects();
    this.currentProjects = projects.map((project) => project.name);
    this.currentProjectColors = new Map(
      projects.map((project) => [project.name, project.color])
    );
    const tasks = await this.readTasks();
    this.currentTasks = tasks;
    const dates = Platform.isMobile
      ? [this.selectedDate]
      : Array.from({ length: 7 }, (_, index) => addDays(this.weekStart, index));
    const board = root.createDiv({ cls: "rm-board-grid" });
    board.toggleClass("is-mobile-day", Platform.isMobile);

    for (const date of dates) {
      this.renderDay(board, date, tasks.filter((task) => task.scheduled === toDateKey(date)));
    }

    if (this.touchDrag) root.addClass("is-touch-dragging");
  }

  renderToolbar(root) {
    const toolbar = root.createDiv({ cls: "rm-toolbar" });
    const left = toolbar.createDiv({ cls: "rm-toolbar__nav" });

    const prev = left.createEl("button", {
      cls: "rm-icon-button",
      attr: { "aria-label": Platform.isMobile ? "Предыдущий день" : "Предыдущая неделя" },
    });
    if (Platform.isMobile) prev.dataset.mobileDayDirection = "-1";
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
    if (Platform.isMobile) next.dataset.mobileDayDirection = "1";
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

    const actions = toolbar.createDiv({ cls: "rm-toolbar__actions" });
    const addProject = actions.createEl("button", {
      cls: "rm-icon-button",
      attr: { "aria-label": "Добавить проект", title: "Добавить проект" },
    });
    setIcon(addProject, "plus");
    addProject.onclick = () => new CreateProjectModal(this.app, this).open();

    const reload = actions.createEl("button", {
      cls: "rm-icon-button",
      attr: { "aria-label": "Обновить", title: "Обновить" },
    });
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

    for (const project of [...this.currentProjects, NO_PROJECT]) {
      const groupTasks = dayTasks.filter((task) => task.project === project);
      this.renderProjectGroup(day, dateKey, project, groupTasks);
    }
  }

  renderProjectGroup(day, dateKey, project, tasks) {
    const group = day.createDiv({ cls: "rm-project-group" });
    group.dataset.project = project;
    group.dataset.date = dateKey;

    const head = group.createDiv({ cls: "rm-project-group__head" });
    const dot = head.createEl("button", {
      cls: `rm-project-dot rm-project-dot--${projectClass(project)}`,
      attr: {
        type: "button",
        "aria-label": `Изменить цвет проекта ${project}`,
        title: "Изменить цвет проекта",
      },
    });
    dot.style.backgroundColor = this.colorForProject(project);
    if (project === NO_PROJECT) dot.disabled = true;
    else dot.onclick = () => new ProjectColorModal(this.app, this, project).open();
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

    const form = group.createEl("form", { cls: "rm-new-task-form" });
    const input = form.createEl("input", {
      cls: "rm-new-task",
      attr: {
        type: "text",
        placeholder: "Добавить задачу",
        "aria-label": `Добавить задачу: ${project}, ${dateKey}`,
        enterkeyhint: "done",
        autocomplete: "off",
      },
    });
    let submitting = false;
    const submitTask = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (submitting) return;
      const title = input.value.trim();
      if (!title) return;
      submitting = true;
      input.value = "";
      input.blur();
      await this.createTask(title, dateKey, project);
    };
    input.addEventListener("keydown", (event) => {
      const isEnter = event.key === "Enter" || event.keyCode === 13 || event.which === 13;
      if (isEnter) void submitTask(event);
    });
    input.addEventListener("beforeinput", (event) => {
      if (event.inputType === "insertLineBreak" || event.inputType === "insertParagraph") {
        void submitTask(event);
      }
    });
    form.addEventListener("submit", (event) => {
      void submitTask(event);
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

  registerTouchDrag(card, task) {
    card.addEventListener("contextmenu", (event) => {
      if (this.touchDrag?.active) event.preventDefault();
    });
    card.addEventListener(
      "touchstart",
      (event) => {
        if (event.touches.length !== 1 || event.target.closest("input, button")) return;
        this.prepareTouchDrag(card, task, event.touches[0]);
      },
      { passive: true }
    );
  }

  prepareTouchDrag(card, task, startTouch) {
    this.cancelTouchDrag();
    const state = {
      task,
      card,
      touchId: startTouch.identifier,
      startX: startTouch.clientX,
      startY: startTouch.clientY,
      initialDate: toDateKey(this.selectedDate),
      targetDate: toDateKey(this.selectedDate),
      active: false,
      moved: false,
      arrowArmed: true,
      arrowTimer: null,
      navigating: false,
      ghost: null,
      cleanup: null,
      holdTimer: null,
    };

    const cleanup = () => {
      window.removeEventListener("touchmove", move, true);
      window.removeEventListener("touchend", finish, true);
      window.removeEventListener("touchcancel", cancel, true);
    };
    state.cleanup = cleanup;

    const activate = () => {
      if (this.touchDrag !== state) return;
      state.active = true;
      const rect = card.getBoundingClientRect();
      const ghost = card.cloneNode(true);
      ghost.addClass("rm-touch-drag-ghost");
      ghost.style.left = `${rect.left}px`;
      ghost.style.top = `${rect.top}px`;
      ghost.style.width = `${rect.width}px`;
      ghost.style.height = `${rect.height}px`;
      document.body.appendChild(ghost);
      state.ghost = ghost;
      card.addClass("is-touch-dragging");
      this.contentEl.addClass("is-touch-dragging");
      if (navigator.vibrate) navigator.vibrate(20);
    };

    const move = (event) => {
      const touch = this.findTouch(event.touches, state.touchId);
      if (!touch || this.touchDrag !== state) return;
      const dx = touch.clientX - state.startX;
      const dy = touch.clientY - state.startY;
      if (!state.active && Math.hypot(dx, dy) > 10) {
        this.cancelTouchDrag();
        return;
      }
      if (!state.active) return;
      event.preventDefault();
      if (Math.hypot(dx, dy) > 8) state.moved = true;
      state.ghost?.style.setProperty("transform", `translate3d(${dx}px, ${dy}px, 0)`);
      this.updateTouchDropTarget(state, touch.clientX, touch.clientY);
      this.autoScrollTouchDrag(touch.clientY);
    };

    const finish = async (event) => {
      const touch = this.findTouch(event.changedTouches, state.touchId);
      if (!touch || this.touchDrag !== state) return;
      if (!state.active) {
        this.cancelTouchDrag();
        return;
      }
      event.preventDefault();
      this.suppressClickUntil = Date.now() + 500;
      if (!state.moved) {
        this.cancelTouchDrag();
        return;
      }
      const group = this.findDropElementAt(touch.clientX, touch.clientY);
      const targetDate = group?.dataset.date;
      const targetProject = group?.dataset.project;
      this.cancelTouchDrag();
      if (!targetDate || !targetProject) {
        if (state.targetDate !== state.initialDate) await this.render();
        return;
      }
      if (targetDate === task.scheduled && targetProject === task.project) return;
      await this.moveTask(task.path, targetDate, targetProject);
      this.selectedDate = fromDateKey(targetDate);
      new Notice(`Задача перенесена: ${formatShortDate(this.selectedDate)}, ${targetProject}`);
      await this.render();
    };

    const cancel = (event) => {
      if (!this.findTouch(event.changedTouches, state.touchId)) return;
      const dateChanged = state.targetDate !== state.initialDate;
      this.cancelTouchDrag();
      if (dateChanged) this.render();
    };

    state.holdTimer = window.setTimeout(activate, 320);
    this.touchDrag = state;
    window.addEventListener("touchmove", move, { passive: false, capture: true });
    window.addEventListener("touchend", finish, { passive: false, capture: true });
    window.addEventListener("touchcancel", cancel, { capture: true });
  }

  findTouch(touchList, touchId) {
    for (let index = 0; index < touchList.length; index += 1) {
      if (touchList[index].identifier === touchId) return touchList[index];
    }
    return null;
  }

  cancelTouchDrag() {
    const state = this.touchDrag;
    if (!state) return;
    if (state.holdTimer) window.clearTimeout(state.holdTimer);
    if (state.arrowTimer) window.clearTimeout(state.arrowTimer);
    state.cleanup?.();
    state.ghost?.remove();
    this.contentEl.querySelector(".rm-mobile-project-drop-sheet")?.remove();
    state.card?.removeClass("is-touch-dragging");
    this.contentEl.removeClass("is-touch-dragging");
    this.contentEl
      .querySelectorAll(".is-drop-target, .is-drag-hover")
      .forEach((element) => element.removeClass("is-drop-target", "is-drag-hover"));
    this.touchDrag = null;
  }

  updateTouchDropTarget(state, clientX, clientY) {
    const arrow = this.findElementByRect("[data-mobile-day-direction]", clientX, clientY);
    const group = this.findDropElementAt(clientX, clientY);

    this.contentEl
      .querySelectorAll(".is-drop-target")
      .forEach((element) => element.removeClass("is-drop-target"));
    if (group) group.addClass("is-drop-target");

    this.contentEl.querySelectorAll(".is-drag-hover").forEach((element) => element.removeClass("is-drag-hover"));
    if (!arrow) {
      state.arrowArmed = true;
      if (state.arrowTimer) window.clearTimeout(state.arrowTimer);
      state.arrowTimer = null;
      return;
    }

    arrow.addClass("is-drag-hover");
    if (!state.arrowArmed || state.arrowTimer || state.navigating) return;
    const direction = Number(arrow.dataset.mobileDayDirection);
    state.arrowTimer = window.setTimeout(async () => {
      state.arrowTimer = null;
      if (this.touchDrag !== state || !state.active) return;
      state.arrowArmed = false;
      state.navigating = true;
      this.selectedDate = addDays(this.selectedDate, direction);
      state.targetDate = toDateKey(this.selectedDate);
      this.showMobileProjectDropSheet(state.targetDate);
      const title = this.contentEl.querySelector(".rm-toolbar__title");
      if (title) title.textContent = formatLongDate(this.selectedDate);
      if (navigator.vibrate) navigator.vibrate(12);
      state.navigating = false;
    }, 450);
  }

  findElementByRect(selector, clientX, clientY) {
    return [...this.contentEl.querySelectorAll(selector)].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    });
  }

  findDropElementAt(clientX, clientY) {
    const sheet = this.contentEl.querySelector(".rm-mobile-project-drop-sheet");
    if (sheet) {
      return this.findElementByRect(".rm-mobile-project-drop-target", clientX, clientY);
    }
    return this.findElementByRect(".rm-project-group", clientX, clientY);
  }

  showMobileProjectDropSheet(dateKey) {
    this.contentEl.querySelector(".rm-mobile-project-drop-sheet")?.remove();
    const boardRect = this.contentEl.querySelector(".rm-board-grid")?.getBoundingClientRect();
    const contentRect = this.contentEl.getBoundingClientRect();
    const sheet = this.contentEl.createDiv({ cls: "rm-mobile-project-drop-sheet" });
    sheet.style.top = `${Math.max(boardRect?.top || contentRect.top + 100, contentRect.top + 90)}px`;
    sheet.style.left = `${contentRect.left + 8}px`;
    sheet.style.right = `${Math.max(window.innerWidth - contentRect.right + 8, 8)}px`;

    const date = fromDateKey(dateKey);
    const dayHeader = sheet.createDiv({ cls: "rm-day__header" });
    dayHeader.createDiv({ cls: "rm-day__name", text: formatWeekday(date) });
    dayHeader.createDiv({ cls: "rm-day__date", text: formatShortDate(date) });

    for (const project of [...this.currentProjects, NO_PROJECT]) {
      const tasks = (this.currentTasks || []).filter(
        (task) => task.scheduled === dateKey && task.project === project
      );
      const target = sheet.createDiv({ cls: "rm-mobile-project-drop-target" });
      target.dataset.date = dateKey;
      target.dataset.project = project;
      const head = target.createDiv({ cls: "rm-project-group__head" });
      const dot = head.createSpan({ cls: `rm-project-dot rm-project-dot--${projectClass(project)}` });
      dot.style.backgroundColor = this.colorForProject(project);
      head.createSpan({ cls: "rm-project-title", text: project });
      head.createSpan({ cls: "rm-project-count", text: String(tasks.length) });
      const list = target.createDiv({ cls: "rm-task-list" });
      for (const task of tasks.sort(taskSort)) {
        const preview = list.createDiv({ cls: "rm-task rm-task--drop-preview" });
        preview.toggleClass("is-done", task.done);
        const checkbox = preview.createEl("input", {
          cls: "rm-task__check",
          attr: { type: "checkbox", disabled: "true" },
        });
        checkbox.checked = task.done;
        preview.createDiv({ cls: "rm-task__title", text: task.title });
      }
      target.createDiv({ cls: "rm-mobile-project-drop-hint", text: "Отпустить в этот проект" });
    }
  }

  autoScrollTouchDrag(clientY) {
    const edge = 72;
    const scrollTarget =
      this.contentEl.querySelector(".rm-mobile-project-drop-sheet") || this.contentEl;
    if (clientY < edge) scrollTarget.scrollBy({ top: -12 });
    else if (clientY > window.innerHeight - edge) scrollTarget.scrollBy({ top: 12 });
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

  async readProjects() {
    const projects = await readProjectNotes(this.app);
    return projects.length
      ? projects
      : DEFAULT_PROJECTS.map((name, index) => ({
          name,
          order: index + 1,
          color: defaultProjectColor(name),
        }));
  }

  colorForProject(project) {
    return this.currentProjectColors?.get(project) || defaultProjectColor(project);
  }

  async createProject(name, color) {
    const cleanName = validateProjectName(name);
    const cleanColor = normalizeProjectColor(color) || defaultProjectColor(cleanName);
    const projects = await readProjectNotes(this.app);
    const duplicate = projects.find(
      (project) => project.name.localeCompare(cleanName, "ru", { sensitivity: "accent" }) === 0
    );
    if (duplicate) throw new Error("Проект с таким названием уже существует");

    await ensureFolder(this.app, PROJECTS_FOLDER);
    const path = normalizePath(`${PROJECTS_FOLDER}/${cleanName}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      throw new Error("Файл проекта с таким названием уже существует");
    }

    const projectOrder = projects.reduce(
      (maximum, project) => Math.max(maximum, project.order),
      0
    ) + 1;
    const frontmatter = {
      tags: ["project"],
      projectOrder,
      projectColor: cleanColor,
    };
    const content = `---\n${stringifyYaml(frontmatter)}---\n\n# ${cleanName}\n`;
    await this.app.vault.create(path, content);
    new Notice(`Проект добавлен: ${cleanName}`);
    await this.render();
  }

  async setProjectColor(projectName, color) {
    const cleanColor = normalizeProjectColor(color);
    if (!cleanColor) throw new Error("Выберите корректный цвет");
    const projects = await readProjectNotes(this.app);
    const project = projects.find((item) => item.name === projectName);
    if (!project) throw new Error("Файл проекта не найден");

    await this.app.vault.process(project.file, (content) => {
      const parsed = splitFrontmatter(content);
      parsed.frontmatter.projectColor = cleanColor;
      return `---\n${stringifyYaml(parsed.frontmatter)}---\n${parsed.body}`;
    });
    new Notice(`Цвет проекта изменён: ${projectName}`);
    await this.render();
  }

  async createTask(title, scheduled, project) {
    await ensureFolder(this.app, TASKS_FOLDER);
    const filename = await this.nextTaskPath(title);
    const now = new Date().toISOString();
    const fm = {
      title,
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
    await this.createUniqueFile(filename, content);
    new Notice(`Задача добавлена: ${title}`);
  }

  async nextTaskPath(title) {
    const base = sanitizeFilename(title) || "Новая задача";
    const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    let path = normalizePath(`${TASKS_FOLDER}/${base}-${suffix}.md`);
    let index = 2;
    while (this.app.vault.getAbstractFileByPath(path) || await this.app.vault.adapter.exists(path)) {
      path = normalizePath(`${TASKS_FOLDER}/${base}-${suffix}-${index}.md`);
      index += 1;
    }
    return path;
  }

  async createUniqueFile(path, content) {
    try {
      await this.app.vault.create(path, content);
    } catch (error) {
      if (!String(error?.message || error).includes("File already exists")) {
        throw error;
      }
      const fallbackPath = normalizePath(
        `${TASKS_FOLDER}/task-${Date.now()}-${Math.random().toString(16).slice(2)}.md`
      );
      await this.app.vault.create(fallbackPath, content);
    }
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

class CreateProjectModal extends Modal {
  constructor(app, view) {
    super(app);
    this.view = view;
    this.submitting = false;
    this.selectedColor = PROJECT_COLORS[0].value;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("rm-create-project-modal");
    contentEl.createEl("h2", { text: "Новый проект" });

    const form = contentEl.createEl("form", { cls: "rm-create-project-form" });
    const label = form.createEl("label", {
      cls: "rm-create-project-label",
      text: "Название проекта",
      attr: { for: "rm-create-project-name" },
    });
    const input = form.createEl("input", {
      cls: "rm-create-project-input",
      attr: {
        id: "rm-create-project-name",
        type: "text",
        maxlength: "80",
        autocomplete: "off",
        enterkeyhint: "done",
      },
    });
    label.htmlFor = input.id;
    const error = form.createDiv({
      cls: "rm-create-project-error",
      attr: { role: "alert", "aria-live": "polite" },
    });
    renderColorPicker(form, this.selectedColor, (color) => {
      this.selectedColor = color;
    });

    const actions = form.createDiv({ cls: "rm-create-project-actions" });
    const cancel = actions.createEl("button", {
      text: "Отмена",
      attr: { type: "button" },
    });
    cancel.onclick = () => this.close();
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: "Добавить",
      attr: { type: "submit" },
    });

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (this.submitting) return;
      error.empty();
      this.submitting = true;
      submit.disabled = true;
      try {
        await this.view.createProject(input.value, this.selectedColor);
        this.close();
      } catch (caught) {
        error.textContent = caught instanceof Error ? caught.message : "Не удалось создать проект";
        input.focus();
        input.select();
      } finally {
        this.submitting = false;
        submit.disabled = false;
      }
    };

    window.setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ProjectColorModal extends Modal {
  constructor(app, view, projectName) {
    super(app);
    this.view = view;
    this.projectName = projectName;
    this.selectedColor = view.colorForProject(projectName);
    this.submitting = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("rm-create-project-modal");
    contentEl.createEl("h2", { text: `Цвет проекта «${this.projectName}»` });

    const form = contentEl.createEl("form", { cls: "rm-create-project-form" });
    renderColorPicker(form, this.selectedColor, (color) => {
      this.selectedColor = color;
    });
    const error = form.createDiv({
      cls: "rm-create-project-error",
      attr: { role: "alert", "aria-live": "polite" },
    });
    const actions = form.createDiv({ cls: "rm-create-project-actions" });
    const cancel = actions.createEl("button", {
      text: "Отмена",
      attr: { type: "button" },
    });
    cancel.onclick = () => this.close();
    const submit = actions.createEl("button", {
      cls: "mod-cta",
      text: "Сохранить",
      attr: { type: "submit" },
    });

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (this.submitting) return;
      this.submitting = true;
      submit.disabled = true;
      try {
        await this.view.setProjectColor(this.projectName, this.selectedColor);
        this.close();
      } catch (caught) {
        error.textContent = caught instanceof Error ? caught.message : "Не удалось изменить цвет";
      } finally {
        this.submitting = false;
        submit.disabled = false;
      }
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

function renderColorPicker(container, initialColor, onChange) {
  container.createDiv({ cls: "rm-color-picker-label", text: "Цвет проекта" });
  const picker = container.createDiv({ cls: "rm-color-picker" });
  const swatches = [];
  let selectedColor = normalizeProjectColor(initialColor) || PROJECT_COLORS[0].value;

  const selectColor = (color) => {
    selectedColor = color;
    for (const swatch of swatches) {
      const selected = swatch.dataset.color === selectedColor;
      swatch.toggleClass("is-selected", selected);
      swatch.setAttribute("aria-pressed", String(selected));
    }
    custom.value = selectedColor;
    onChange(selectedColor);
  };

  for (const option of PROJECT_COLORS) {
    const swatch = picker.createEl("button", {
      cls: "rm-color-swatch",
      attr: {
        type: "button",
        "aria-label": option.name,
        "aria-pressed": "false",
        title: option.name,
      },
    });
    swatch.dataset.color = option.value;
    swatch.style.backgroundColor = option.value;
    swatch.onclick = () => selectColor(option.value);
    swatches.push(swatch);
  }

  const customWrap = container.createDiv({ cls: "rm-custom-color" });
  customWrap.createSpan({ text: "Свой цвет" });
  const custom = customWrap.createEl("input", {
    attr: {
      type: "color",
      value: selectedColor,
      "aria-label": "Выбрать свой цвет",
    },
  });
  custom.oninput = () => selectColor(custom.value.toLowerCase());
  selectColor(selectedColor);
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
  await ensureFolder(app, TASKS_FOLDER);
  const filename = await nextTaskPath(app, title);
  const now = new Date().toISOString();
  const fm = {
    title,
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
  await createUniqueTaskNoteFile(app, filename, content);
}

async function readProjectNotes(app) {
  const projects = [];
  for (const file of projectNoteFiles(app)) {
    const fm = await readTaskFrontmatter(app, file);
    if (!isProjectFrontmatter(fm)) continue;
    const parsedOrder = Number(fm.projectOrder);
    projects.push({
      name: cleanTitle(fm.title || file.basename),
      order: Number.isFinite(parsedOrder) ? parsedOrder : Number.MAX_SAFE_INTEGER,
      color: normalizeProjectColor(fm.projectColor) || defaultProjectColor(file.basename),
      file,
    });
  }
  return projects.sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name, "ru", { sensitivity: "base" })
  );
}

function projectNoteFiles(app) {
  const folderPrefix = `${PROJECTS_FOLDER}/`;
  return app.vault
    .getMarkdownFiles()
    .filter((file) => file.path.startsWith(folderPrefix));
}

async function nextTaskPath(app, title) {
  const base = sanitizeFilename(title) || "New task";
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  let path = normalizePath(`${TASKS_FOLDER}/${base}-${suffix}.md`);
  let index = 2;
  while (app.vault.getAbstractFileByPath(path) || await app.vault.adapter.exists(path)) {
    path = normalizePath(`${TASKS_FOLDER}/${base}-${suffix}-${index}.md`);
    index += 1;
  }
  return path;
}

async function createUniqueTaskNoteFile(app, path, content) {
  try {
    await app.vault.create(path, content);
  } catch (error) {
    if (!String(error?.message || error).includes("File already exists")) {
      throw error;
    }
    const fallbackPath = normalizePath(
      `${TASKS_FOLDER}/task-${Date.now()}-${Math.random().toString(16).slice(2)}.md`
    );
    await app.vault.create(fallbackPath, content);
  }
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

function isProjectFrontmatter(fm) {
  const tags = Array.isArray(fm.tags) ? fm.tags : typeof fm.tags === "string" ? [fm.tags] : [];
  return tags.map((tag) => String(tag).replace(/^#/, "")).includes("project");
}

async function ensureFolder(app, folderPath) {
  const normalized = normalizePath(folderPath);
  const segments = normalized.split("/");
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getAbstractFileByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}

function validateProjectName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Введите название проекта");
  if (name.length > 80) throw new Error("Название должно быть не длиннее 80 символов");
  if (name === "." || name === ".." || /[\\/:*?"<>|#^[\]]/.test(name)) {
    throw new Error("В названии есть недопустимые символы");
  }
  return name;
}

function normalizeProjectColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

function normalizeDate(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function normalizeProject(projects) {
  const list = Array.isArray(projects) ? projects : projects ? [projects] : [];
  const labels = list.map((project) => projectLabel(project)).filter(Boolean);
  return labels[0] || NO_PROJECT;
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

function defaultProjectColor(project) {
  if (project === "RareMod") return "#22c55e";
  if (project === "Личное") return "#60a5fa";
  if (project === "Parfume") return "#f59e0b";
  if (project === "Traker") return "#a78bfa";
  if (project === NO_PROJECT) return "#9ca3af";
  const colors = ["#14b8a6", "#ec4899", "#eab308", "#06b6d4", "#f97316", "#8b5cf6"];
  let hash = 0;
  for (const character of project) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  return colors[hash % colors.length];
}

function taskSort(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  return a.title.localeCompare(b.title, "ru");
}
