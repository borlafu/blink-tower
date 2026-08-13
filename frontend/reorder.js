"use strict";

// Drag-and-drop tile reordering, scoped to one location grid.
//
// Uses native HTML5 drag events (no library). A tile is only draggable while the
// pointer is held on its handle, so the live-view controls and text selection
// keep working. Dragging is deliberately in-group only: the drop zone ignores a
// drag whose tile does not belong to this grid, which makes a cross-location
// drop a no-op instead of silently moving a camera to another location.

/**
 * Find the tile that the dragged one should be inserted before.
 *
 * The grid wraps, so both axes matter: a pointer above a tile's middle, or left
 * of it on the same visual row, means "insert before this one". Returns null to
 * append at the end.
 */
function tileAfterPointer(container, clientX, clientY) {
  const candidates = [...container.querySelectorAll(".cell:not(.dragging)")];
  return (
    candidates.find((cell) => {
      const box = cell.getBoundingClientRect();
      const aboveMiddle = clientY < box.top + box.height / 2;
      const sameRowAndLeft =
        clientY < box.bottom && clientX < box.left + box.width / 2;
      return aboveMiddle || sameRowAndLeft;
    }) || null
  );
}

/** Current camera order of a grid, read straight from the DOM. */
export function tileOrder(container) {
  return [...container.querySelectorAll(".cell")].map((cell) => cell.dataset.camera);
}

/**
 * Make ``cell`` draggable by its ``handle``.
 *
 * ``onDropped`` is called once the drag finishes, with the grid's resulting
 * camera order, so the caller can persist it.
 */
export function makeDraggable(cell, handle, onDropped) {
  handle.addEventListener("mousedown", () => {
    cell.draggable = true;
  });
  handle.addEventListener("mouseup", () => {
    cell.draggable = false;
  });

  cell.addEventListener("dragstart", (event) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", cell.dataset.camera);
    cell.classList.add("dragging");
  });

  cell.addEventListener("dragend", () => {
    cell.draggable = false;
    cell.classList.remove("dragging");
    const container = cell.parentElement;
    if (container) onDropped(tileOrder(container));
  });
}

/**
 * Let tiles be dropped into ``container`` to reorder them.
 *
 * Reordering is previewed live during the drag; nothing is persisted here —
 * ``makeDraggable``'s ``onDropped`` does that on dragend.
 */
export function enableDropZone(container) {
  container.addEventListener("dragover", (event) => {
    // Only react to a tile from this very grid: in-group reordering only.
    const dragging = container.querySelector(".cell.dragging");
    if (!dragging) return;

    event.preventDefault();
    const before = tileAfterPointer(container, event.clientX, event.clientY);
    if (before === dragging) return;
    container.insertBefore(dragging, before);
  });

  // Without a drop handler the browser animates the tile snapping back.
  container.addEventListener("drop", (event) => {
    if (container.querySelector(".cell.dragging")) event.preventDefault();
  });
}
