/* ============================================================
 * whiteboard.js — 独立白板应用逻辑
 *
 * 数据隔离策略：
 *  1) 独立状态容器 WB，不引用批注模块的任何变量或 DOM；
 *  2) 独立 localStorage 键 zk_whiteboard_v1，绝不读写批注存储；
 *  3) 独立画布 / 独立文字批注层 / 独立输入浮层；
 *  4) 进入与退出均为页面级导航，不触碰 body.annotation-active 等批注状态。
 * 底层绘图算法复用 InkCore（与批注同源的纯能力层）。
 * ============================================================ */
(function () {
    'use strict';

    var WB_KEY = 'zk_whiteboard_v1';
    var stage = document.getElementById('wbStage');
    var canvas = document.getElementById('wbCanvas');
    var ctx = canvas.getContext('2d', { desynchronized: true });
    var notesLayer = document.getElementById('wbNotes');
    var emptyHint = document.getElementById('wbEmpty');
    var toolbar = document.getElementById('wbToolbar');
    var colorInput = document.getElementById('wbColor');
    var widthInput = document.getElementById('wbWidth');
    var widthValue = document.getElementById('wbWidthValue');
    var hint = document.getElementById('wbHint');
    var saveState = document.getElementById('wbSaveState');
    var noteEditor = document.getElementById('wbNoteEditor');
    var noteInput = document.getElementById('wbNoteInput');
    var noteOk = document.getElementById('wbNoteOk');
    var noteCancel = document.getElementById('wbNoteCancel');

    // 独立状态：与批注完全不共享
    var WB = {
        strokes: [],
        notes: [],
        tool: 'pen',
        color: '#dc2626',
        width: 4,
        drawing: null,
        erasing: false,
        pendingNote: null,
        history: [],
        dpr: 1
    };

    var HINTS = {
        pen: '画笔：按住拖动绘制 · 笔锋随压感/速度变化',
        note: '批注：点击画布任意位置添加文字',
        erase: '擦除：点击或拖动移除笔画与文字批注'
    };

    function outlineToArray(g) {
        var o = g.outline || g.outlineInfo;
        if (!o || !o.from || !o.to) return null;
        var dir = o.dir || InkCore.outlineDirection(o.from, o.to, null);
        return [o.from.x, o.from.y, o.to.x, o.to.y, o.startWidth, o.endWidth, dir.x, dir.y];
    }

    function rebuildStroke(d) {
        var outlines = (d.outlines || []).map(function (o) {
            if (!o || o.length < 6) return null;
            var from = { x: o[0], y: o[1] };
            var to = { x: o[2], y: o[3] };
            if (o.length >= 8) {
                return { from: from, to: to, startWidth: o[4], endWidth: o[5], dir: { x: o[6], y: o[7] } };
            }
            var width = d.width || 4;
            return {
                from: from, to: to,
                startWidth: width * (.25 + o[4] * 1.25),
                endWidth: width * (.25 + o[5] * 1.25),
                dir: InkCore.outlineDirection(from, to, null)
            };
        });
        function dirOf(o) {
            return o.dir || InkCore.outlineDirection(o.from, o.to, null);
        }
        var segs = (d.pathData || []).map(function (p, i) {
            var o = outlines[i];
            var width = d.widths && d.widths[i] ? d.widths[i] : d.width;
            var fillPath = null;
            if (o) {
                var dir = dirOf(o);
                var prevDir = outlines[i - 1] ? dirOf(outlines[i - 1]) : dir;
                var nextDir = outlines[i + 1] ? dirOf(outlines[i + 1]) : dir;
                fillPath = InkCore.buildFillPath(
                    o.from, o.to,
                    InkCore.miterNormal(prevDir, dir),
                    InkCore.miterNormal(dir, nextDir),
                    o.startWidth, o.endWidth
                );
            }
            return {
                pathData: p,
                strokeWidth: width,
                outline: o,
                outlineInfo: null,
                fillPath: fillPath,
                path: typeof Path2D !== 'undefined' ? new Path2D(p) : null
            };
        });
        return {
            id: d.id || ('s' + Math.random().toString(36).slice(2)),
            color: d.color, width: d.width,
            opacity: d.opacity == null ? 1 : d.opacity,
            segments: segs,
            points: (d.points || []).map(function (p) { return { x: p.x, y: p.y, pressure: .7, timeStamp: 0 }; }),
            lastPoint: { x: 0, y: 0, pressure: .7, timeStamp: 0 }
        };
    }

    function save() {
        try {
            localStorage.setItem(WB_KEY, JSON.stringify({
                strokes: WB.strokes.map(function (s) {
                    return { id: s.id, color: s.color, width: s.width, opacity: s.opacity,
                        pathData: s.segments.map(function (g) { return g.pathData; }),
                        widths: s.segments.map(function (g) { return g.strokeWidth; }),
                        outlines: s.segments.map(outlineToArray),
                        points: s.points.map(function (p) { return { x: p.x, y: p.y }; }) };
                }),
                notes: WB.notes
            }));
            saveState.textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            saveState.textContent = '仅当前会话有效';
        }
    }

    function load() {
        try {
            var raw = localStorage.getItem(WB_KEY);
            if (!raw) return;
            var data = JSON.parse(raw);
            (data.strokes || []).forEach(function (d) { WB.strokes.push(rebuildStroke(d)); });
            WB.notes = (data.notes || []).slice();
            if (WB.strokes.length || WB.notes.length) saveState.textContent = '已恢复上次白板';
        } catch (e) { /* 忽略损坏的独立数据，绝不影响批注 */ }
    }

    function resize() {
        WB.dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(window.innerWidth * WB.dpr));
        canvas.height = Math.max(1, Math.round(window.innerHeight * WB.dpr));
        ctx.setTransform(WB.dpr, 0, 0, WB.dpr, 0, 0);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        redraw();
    }

    function redraw() {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(WB.dpr, 0, 0, WB.dpr, 0, 0);
        WB.strokes.forEach(function (s) { InkCore.renderStroke(ctx, s); });
        ctx.globalAlpha = 1;
        renderNotes();
        emptyHint.hidden = WB.strokes.length > 0 || WB.notes.length > 0;
    }

    function renderNotes() {
        notesLayer.replaceChildren();
        WB.notes.forEach(function (n) {
            var el = document.createElement('div');
            el.className = 'wb-note';
            el.textContent = n.text;
            el.style.left = n.x + 'px';
            el.style.top = n.y + 'px';
            notesLayer.appendChild(el);
        });
    }

    function setTool(tool) {
        WB.tool = tool;
        toolbar.querySelectorAll('[data-wb-tool]').forEach(function (b) {
            var active = b.dataset.wbTool === tool;
            b.classList.toggle('active', active);
            b.setAttribute('aria-pressed', String(active));
        });
        hint.textContent = HINTS[tool] || '';
        stage.style.cursor = tool === 'note' ? 'text' : (tool === 'erase' ? 'cell' : 'crosshair');
    }

    function pointOf(event) {
        return { x: event.clientX, y: event.clientY };
    }

    function pushHistory(action) {
        WB.history.push(action);
        if (WB.history.length > 50) WB.history.shift();
    }

    /* ---------- 画笔：复用 InkCore 的压感/平滑管线，增量渲染 ---------- */
    function flushDrawing() {
        if (!WB.drawing) return;
        if (WB.drawing.pendingFrame !== null) {
            window.cancelAnimationFrame(WB.drawing.pendingFrame);
            WB.drawing.pendingFrame = null;
        }
        var points = WB.drawing.pendingPoints.splice(0);
        if (!points.length) return;
        InkCore.appendSamples(WB.drawing, points);
        InkCore.renderNewSegments(ctx, WB.drawing, WB.drawing.color, WB.drawing.opacity);
        emptyHint.hidden = true;
    }

    function beginPen(event) {
        event.preventDefault();
        stage.setPointerCapture(event.pointerId);
        var p = pointOf(event);
        var sample = {
            clientX: p.x, clientY: p.y,
            pressure: event.pointerType === 'pen' && event.pressure > 0 ? Math.max(.12, Math.min(1, event.pressure)) : .7,
            timeStamp: event.timeStamp
        };
        var stroke = InkCore.createStroke({
            point: p, pressure: sample.pressure, timeStamp: sample.timeStamp,
            color: WB.color, width: WB.width
        });
        WB.strokes.push(stroke);
        WB.drawing = stroke;
        pushHistory({ type: 'stroke', id: stroke.id });
        // 起笔点：画一个圆点，保证轻点也可见
        ctx.fillStyle = stroke.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
    }

    /* ---------- 擦除：只操作白板自己的 strokes / notes ---------- */
    function eraseAt(x, y) {
        var before = WB.strokes.length + WB.notes.length;
        WB.strokes = WB.strokes.filter(function (s) { return !InkCore.hitStroke(s, x, y, 14); });
        WB.notes = WB.notes.filter(function (n) {
            return !(x >= n.x - 16 && x <= n.x + 290 && y >= n.y - 16 && y <= n.y + 46);
        });
        if (before !== WB.strokes.length + WB.notes.length) {
            pushHistory({ type: 'snapshot', strokes: snapshotStrokes(), notes: WB.notes.slice() });
            redraw();
            save();
        }
    }

    function snapshotStrokes() {
        return WB.strokes.map(function (s) {
            return { id: s.id, color: s.color, width: s.width, opacity: s.opacity,
                pathData: s.segments.map(function (g) { return g.pathData; }),
                widths: s.segments.map(function (g) { return g.strokeWidth; }),
                outlines: s.segments.map(outlineToArray),
                points: s.points.map(function (p) { return { x: p.x, y: p.y }; }) };
        });
    }

    /* ---------- 文字批注：独立的输入浮层与独立 notes 数组 ---------- */
    function openNoteEditor(x, y) {
        WB.pendingNote = { x: x, y: y };
        noteEditor.hidden = false;
        var left = Math.min(Math.max(8, x), window.innerWidth - 340);
        var top = Math.min(Math.max(64, y), window.innerHeight - 80);
        noteEditor.style.left = left + 'px';
        noteEditor.style.top = top + 'px';
        noteInput.value = '';
        noteInput.focus();
    }

    function commitNote() {
        if (!WB.pendingNote) return;
        var text = noteInput.value.trim();
        if (text) {
            WB.notes.push({ x: WB.pendingNote.x, y: WB.pendingNote.y, text: text });
            pushHistory({ type: 'note', x: WB.pendingNote.x, y: WB.pendingNote.y });
            redraw();
            save();
        }
        closeNoteEditor();
    }

    function closeNoteEditor() {
        noteEditor.hidden = true;
        WB.pendingNote = null;
    }

    /* ---------- 事件绑定：仅绑定白板自己的 DOM ---------- */
    stage.addEventListener('pointerdown', function (event) {
        if (event.button !== 0 && event.pointerType === 'mouse') return;
        var p = pointOf(event);
        if (WB.tool === 'note') { event.preventDefault(); openNoteEditor(p.x, p.y); return; }
        if (WB.tool === 'erase') { event.preventDefault(); stage.setPointerCapture(event.pointerId); WB.erasing = true; eraseAt(p.x, p.y); return; }
        beginPen(event);
    });

    stage.addEventListener('pointermove', function (event) {
        if (WB.erasing) {
            var p = pointOf(event);
            eraseAt(p.x, p.y);
            return;
        }
        if (!WB.drawing) return;
        var samples = InkCore.pointerSamples(event);
        for (var i = 0; i < samples.length; i++) WB.drawing.pendingPoints.push(samples[i]);
        if (WB.drawing.pendingFrame === null) {
            WB.drawing.pendingFrame = window.requestAnimationFrame(function () {
                if (!WB.drawing) return;
                WB.drawing.pendingFrame = null;
                flushDrawing();
            });
        }
    });

    function finish(event) {
        if (WB.drawing) {
            flushDrawing();
            InkCore.appendTail(WB.drawing);
            InkCore.renderNewSegments(ctx, WB.drawing, WB.drawing.color, WB.drawing.opacity);
            WB.drawing = null;
            save();
        }
        WB.erasing = false;
        if (stage.hasPointerCapture && stage.hasPointerCapture(event.pointerId)) {
            stage.releasePointerCapture(event.pointerId);
        }
    }
    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', finish);

    toolbar.querySelectorAll('[data-wb-tool]').forEach(function (b) {
        b.addEventListener('click', function () { setTool(b.dataset.wbTool); });
    });
    colorInput.addEventListener('input', function () { WB.color = colorInput.value; });
    widthInput.addEventListener('input', function () {
        WB.width = Number(widthInput.value) || 4;
        widthValue.textContent = WB.width + 'px';
    });
    noteOk.addEventListener('click', commitNote);
    noteCancel.addEventListener('click', closeNoteEditor);
    noteInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commitNote(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeNoteEditor(); }
    });

    document.getElementById('wbUndo').addEventListener('click', undo);
    document.getElementById('wbClear').addEventListener('click', function () {
        if (!WB.strokes.length && !WB.notes.length) return;
        if (!window.confirm('确定清空白板吗？（仅清除白板，不影响文章批注）')) return;
        WB.strokes = [];
        WB.notes = [];
        WB.history = [];
        redraw();
        save();
    });

    function undo() {
        var last = WB.history.pop();
        if (!last) return;
        if (last.type === 'stroke') {
            WB.strokes = WB.strokes.filter(function (s) { return s.id !== last.id; });
        } else if (last.type === 'note') {
            WB.notes.pop();
        } else if (last.type === 'snapshot') {
            WB.strokes = restoreStrokes(last.strokes);
            WB.notes = last.notes.slice();
        }
        redraw();
        save();
    }

    function restoreStrokes(list) {
        return (list || []).map(rebuildStroke);
    }

    window.addEventListener('keydown', function (e) {
        if (!noteEditor.hidden) return;
        if (e.key === 'Escape') { window.location.href = 'index.html'; return; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    });
    window.addEventListener('resize', resize);

    // 初始化
    WB.color = colorInput.value;
    WB.width = Number(widthInput.value) || 4;
    widthValue.textContent = WB.width + 'px';
    setTool('pen');
    load();
    resize();
})();
