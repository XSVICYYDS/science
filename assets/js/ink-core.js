/* ============================================================
 * ink-core.js — 纯绘图能力层
 * 从批注系统抽取的底层绘图算法（压感曲线 / 合并取样 / 贝塞尔平滑 /
 * 变宽分段 / Path2D 缓存 / 命中检测），参数化后作为独立能力复用。
 *
 * 设计约束：
 *  - 不引用任何批注状态（不读 annotationInkStrokes、annotationColor 等）
 *  - 不操作任何 DOM，不绑定事件，不写 localStorage
 *  - 坐标空间由调用方决定（白板用视口坐标，批注用文档坐标）
 * ============================================================ */
(function (global) {
    'use strict';

    /** 合并取样：优先使用浏览器合并事件，降低输入延迟 */
    function pointerSamples(event) {
        var samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
        return samples.length ? samples : [event];
    }

    /** 压感/速度曲线：手写笔用真实压力，鼠标按移动速度估算 */
    function pressure(sample, previous, distance) {
        var p = Number(sample.pressure);
        if (sample.pointerType === 'pen' && isFinite(p) && p > 0) {
            return Math.max(.12, Math.min(1, p));
        }
        var elapsed = Math.max(1, sample.timeStamp - previous.timeStamp);
        var speed = distance / elapsed;
        return Math.max(.22, Math.min(1, 1.05 - speed * .42));
    }

    var SMOOTH_MIN_ALPHA = .32;
    var SMOOTH_MAX_ALPHA = .82;
    var SMOOTH_VELOCITY_KEEP = .38;
    var SMOOTH_PRESSURE_MIN_BETA = .28;
    var SMOOTH_PRESSURE_MAX_BETA = .58;
    var SMOOTH_MIN_STEP = .08;
    var SMOOTH_MAX_STEP = .22;
    var SAMPLE_MIN_DISTANCE = .35;

    function clampNumber(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    /** 速度自适应坐标低通 + 短时预测，和主批注系统共用同一套参数 */
    function smoothSample(sample, stroke) {
        var raw = { x: sample.clientX, y: sample.clientY };
        if (!isFinite(raw.x) || !isFinite(raw.y)) return null;
        var previous = stroke.lastPoint;
        var now = isFinite(sample.timeStamp) ? sample.timeStamp : Date.now();
        var previousTime = isFinite(previous.timeStamp) ? previous.timeStamp : now - 8;
        var elapsed = now - previousTime;
        if (!isFinite(elapsed) || elapsed <= 0) elapsed = 1;
        var dt = Math.min(32, Math.max(1, elapsed));

        var rawDx = raw.x - previous.x;
        var rawDy = raw.y - previous.y;
        var rawDistance = Math.hypot(rawDx, rawDy);
        if (rawDistance < SAMPLE_MIN_DISTANCE) return null;

        var rawSpeed = rawDistance / dt;
        var alpha = clampNumber(SMOOTH_MIN_ALPHA + rawSpeed * .32, SMOOTH_MIN_ALPHA, SMOOTH_MAX_ALPHA);

        var predictedDx = (stroke.smoothVx || 0) * dt;
        var predictedDy = (stroke.smoothVy || 0) * dt;
        var predictedLength = Math.hypot(predictedDx, predictedDy);
        var maxPrediction = rawDistance * .6;
        if (predictedLength > maxPrediction) {
            var scale = maxPrediction / predictedLength;
            predictedDx *= scale;
            predictedDy *= scale;
        }
        var predictedX = previous.x + predictedDx;
        var predictedY = previous.y + predictedDy;
        var x = predictedX + (raw.x - predictedX) * alpha;
        var y = predictedY + (raw.y - predictedY) * alpha;

        var instantVx = (x - previous.x) / dt;
        var instantVy = (y - previous.y) / dt;
        stroke.smoothVx = (stroke.smoothVx || 0) * SMOOTH_VELOCITY_KEEP + instantVx * (1 - SMOOTH_VELOCITY_KEEP);
        stroke.smoothVy = (stroke.smoothVy || 0) * SMOOTH_VELOCITY_KEEP + instantVy * (1 - SMOOTH_VELOCITY_KEEP);

        var rawPressure = pressure(sample, previous, rawDistance);
        var beta = clampNumber(
            SMOOTH_PRESSURE_MIN_BETA + rawSpeed * .18,
            SMOOTH_PRESSURE_MIN_BETA,
            SMOOTH_PRESSURE_MAX_BETA
        );
        var pressureStep = clampNumber(SMOOTH_MIN_STEP + rawSpeed * .12, SMOOTH_MIN_STEP, SMOOTH_MAX_STEP);
        var p = previous.pressure + (rawPressure - previous.pressure) * beta;
        p = clampNumber(p, previous.pressure - pressureStep, previous.pressure + pressureStep);

        return { x: x, y: y, pressure: clampNumber(p, .12, 1), timeStamp: now };
    }

    /**
     * 创建一笔。width 由调用方给定（白板自己的粗细设置），不读取任何外部状态。
     */
    function createStroke(opts) {
        opts = opts || {};
        var point = opts.point || { x: 0, y: 0 };
        var start = {
            x: point.x, y: point.y,
            pressure: Number.isFinite(opts.pressure) ? opts.pressure : .7,
            timeStamp: opts.timeStamp || 0
        };
        return {
            id: opts.id || ('s' + Date.now() + Math.random().toString(36).slice(2, 7)),
            color: opts.color || '#dc2626',
            width: Number(opts.width) || 4,
            opacity: Number.isFinite(opts.opacity) ? opts.opacity : 1,
            segments: [],
            points: [start],
            lastPoint: start,
            renderedPoint: start,
            pendingPoints: [],
            pendingFrame: null,
            smoothVx: 0,
            smoothVy: 0,
            hasMoved: false
        };
    }

    function segmentWidth(stroke, p) {
        return stroke.width * (.25 + p * 1.25);
    }

    /** 参考 Excalidraw/perfect-freehand：延迟斜接的填充轮廓 */
    function outlineDirection(from, to, fallback) {
        var dx = to.x - from.x;
        var dy = to.y - from.y;
        var length = Math.hypot(dx, dy);
        if (!isFinite(length) || length < .0001) return fallback || { x: 1, y: 0 };
        return { x: dx / length, y: dy / length };
    }

    function outlineNormal(dir) {
        return { x: -dir.y, y: dir.x };
    }

    function miterNormal(prevDir, nextDir) {
        var a = outlineNormal(prevDir);
        var b = outlineNormal(nextDir);
        var nx = a.x + b.x;
        var ny = a.y + b.y;
        var length = Math.hypot(nx, ny);
        if (length < .0001) return b;
        nx /= length;
        ny /= length;
        var dot = Math.max(.25, nx * b.x + ny * b.y);
        var scale = Math.min(2, 1 / dot);
        return { x: nx * scale, y: ny * scale };
    }

    function buildFillPath(from, to, startMiter, endMiter, startWidth, endWidth) {
        if (typeof Path2D === 'undefined' || !from || !to) return null;
        var r0 = Math.max(.4, startWidth / 2);
        var r1 = Math.max(.4, endWidth / 2);
        var path = new Path2D();
        path.moveTo(from.x + startMiter.x * r0, from.y + startMiter.y * r0);
        path.lineTo(to.x + endMiter.x * r1, to.y + endMiter.y * r1);
        path.lineTo(to.x - endMiter.x * r1, to.y - endMiter.y * r1);
        path.lineTo(from.x - startMiter.x * r0, from.y - startMiter.y * r0);
        path.closePath();
        return path;
    }

    function resolvePendingOutlines(stroke, final) {
        var queue = stroke.outlinePending;
        if (!queue || !queue.length) return;
        var keep = final ? 0 : 1;
        while (queue.length > keep) {
            var seg = queue.shift();
            var info = seg.outlineInfo;
            if (!info) continue;
            var prevDir = info.prevDir || info.dir;
            var nextDir = queue.length && queue[0].outlineInfo ? queue[0].outlineInfo.dir : info.dir;
            seg.fillPath = buildFillPath(
                info.from, info.to,
                miterNormal(prevDir, info.dir),
                miterNormal(info.dir, nextDir),
                info.startWidth,
                info.endWidth
            );
            seg.outline = info;
            seg.outlineInfo = null;
        }
    }

    function pushSegment(stroke, pathData, p, extra) {
        extra = extra || {};
        var startWidth = segmentWidth(stroke, isFinite(extra.startPressure) ? extra.startPressure : p);
        var endWidth = segmentWidth(stroke, isFinite(extra.endPressure) ? extra.endPressure : p);
        var seg = {
            pathData: pathData,
            strokeWidth: segmentWidth(stroke, p),
            fillPath: null,
            outline: null,
            outlineInfo: null,
            path: typeof Path2D !== 'undefined' ? new Path2D(pathData) : null
        };
        if (extra.born) seg.born = extra.born;
        stroke.segments.push(seg);
        if (extra.outline) {
            var dir = outlineDirection(extra.outline.from, extra.outline.to, stroke.lastOutlineDir);
            if (Math.hypot(extra.outline.to.x - extra.outline.from.x,
                extra.outline.to.y - extra.outline.from.y) >= .0001) {
                seg.outlineInfo = {
                    from: extra.outline.from,
                    to: extra.outline.to,
                    startWidth: startWidth,
                    endWidth: endWidth,
                    dir: dir,
                    prevDir: stroke.lastOutlineDir || dir
                };
                stroke.outlinePending = stroke.outlinePending || [];
                stroke.outlinePending.push(seg);
                stroke.lastOutlineDir = dir;
            }
        }
        return seg;
    }

    /**
     * 追加取样并生成二次/三次贝塞尔平滑段（与批注同一套算法）。
     * 新段会同时写入 stroke.newSegments，供调用方做增量渲染。
     */
    function appendSamples(stroke, events) {
        stroke.newSegments = stroke.newSegments || [];
        stroke.newSegments.length = 0;
        for (var i = 0; i < events.length; i++) {
            var sample = events[i];
            var previous = stroke.lastPoint;
            var point = smoothSample(sample, stroke);
            if (!point) continue;

            stroke.points.push(point);

            var mid, seg;
            if (stroke.points.length === 2) {
                mid = { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
                seg = pushSegment(stroke,
                    'M ' + previous.x + ' ' + previous.y + ' Q ' + previous.x + ' ' + previous.y + ' ' + mid.x + ' ' + mid.y,
                    (previous.pressure + point.pressure) / 2,
                    { outline: { from: previous, to: mid }, startPressure: previous.pressure, endPressure: point.pressure });
                stroke.renderedPoint = mid;
            } else {
                var first = stroke.points[stroke.points.length - 3];
                var middle = previous;
                mid = { x: (middle.x + point.x) / 2, y: (middle.y + point.y) / 2 };
                var c1 = {
                    x: stroke.renderedPoint.x + (middle.x - first.x) / 6,
                    y: stroke.renderedPoint.y + (middle.y - first.y) / 6
                };
                var c2 = {
                    x: mid.x - (point.x - first.x) / 6,
                    y: mid.y - (point.y - first.y) / 6
                };
                seg = pushSegment(stroke,
                    'M ' + stroke.renderedPoint.x + ' ' + stroke.renderedPoint.y +
                    ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + mid.x + ' ' + mid.y,
                    (middle.pressure + point.pressure) / 2,
                    { outline: { from: stroke.renderedPoint, to: mid }, startPressure: middle.pressure, endPressure: point.pressure });
                stroke.renderedPoint = mid;
                stroke.points.shift();
            }
            stroke.newSegments.push(seg);
            stroke.lastPoint = point;
            stroke.hasMoved = true;
        }
        resolvePendingOutlines(stroke, false);
    }

    /** 抬笔收尾：从最后一个中点平滑连接到真实末点 */
    function appendTail(stroke) {
        stroke.newSegments = stroke.newSegments || [];
        stroke.newSegments.length = 0;
        if (!stroke || !stroke.hasMoved) return stroke.newSegments;
        var end = stroke.lastPoint;
        var before = stroke.points[stroke.points.length - 2] || end;
        if (Math.hypot(end.x - stroke.renderedPoint.x, end.y - stroke.renderedPoint.y) < .25) {
            resolvePendingOutlines(stroke, true);
            return stroke.newSegments;
        }
        var dx = end.x - before.x;
        var dy = end.y - before.y;
        var c1 = { x: stroke.renderedPoint.x + dx / 6, y: stroke.renderedPoint.y + dy / 6 };
        var c2 = { x: end.x - dx / 12, y: end.y - dy / 12 };
        var seg = pushSegment(stroke,
            'M ' + stroke.renderedPoint.x + ' ' + stroke.renderedPoint.y +
            ' C ' + c1.x + ' ' + c1.y + ' ' + c2.x + ' ' + c2.y + ' ' + end.x + ' ' + end.y,
            end.pressure,
            { outline: { from: stroke.renderedPoint, to: end }, startPressure: end.pressure, endPressure: end.pressure });
        stroke.newSegments.push(seg);
        resolvePendingOutlines(stroke, true);
        return stroke.newSegments;
    }

    /** 渲染单段（增量绘制用） */
    function renderSegment(ctx, seg, color, opacity) {
        ctx.globalAlpha = opacity;
        if (seg.fillPath) {
            ctx.fillStyle = color;
            ctx.fill(seg.fillPath);
            return;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = seg.strokeWidth;
        if (seg.path) ctx.stroke(seg.path);
    }

    function segmentReady(stroke, seg) {
        return !(seg.outlineInfo && !seg.fillPath);
    }

    /** 增量绘制已经完成斜接解析的新段 */
    function renderNewSegments(ctx, stroke, color, opacity) {
        var start = stroke.renderedSegmentCount || 0;
        var drawn = start;
        for (var i = start; i < stroke.segments.length; i++) {
            var seg = stroke.segments[i];
            if (!segmentReady(stroke, seg)) break;
            renderSegment(ctx, seg, color, opacity);
            drawn = i + 1;
        }
        stroke.renderedSegmentCount = drawn;
        return drawn - start;
    }

    /** 整笔重绘（清除后重建用） */
    function renderStroke(ctx, stroke) {
        ctx.strokeStyle = stroke.color;
        ctx.globalAlpha = stroke.opacity;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (var i = 0; i < stroke.segments.length; i++) {
            if (segmentReady(stroke, stroke.segments[i])) {
                renderSegment(ctx, stroke.segments[i], stroke.color, stroke.opacity);
            }
        }
        ctx.globalAlpha = 1;
    }

    /** 命中检测：点到笔画折线的最短距离，用于擦除 */
    function hitStroke(stroke, x, y, tolerance) {
        var tol = tolerance || 12;
        var pts = stroke.points;
        if (!pts.length) return false;
        if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y) <= tol + stroke.width / 2;
        for (var i = 0; i < pts.length - 1; i++) {
            var ax = pts[i].x, ay = pts[i].y, bx = pts[i + 1].x, by = pts[i + 1].y;
            var dx = bx - ax, dy = by - ay;
            var len2 = dx * dx + dy * dy;
            var t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
            var px = ax + t * dx, py = ay + t * dy;
            if (Math.hypot(x - px, y - py) <= tol + stroke.width / 2) return true;
        }
        return false;
    }

    global.InkCore = {
        pointerSamples: pointerSamples,
        pressure: pressure,
        smoothSample: smoothSample,
        outlineDirection: outlineDirection,
        miterNormal: miterNormal,
        buildFillPath: buildFillPath,
        createStroke: createStroke,
        appendSamples: appendSamples,
        appendTail: appendTail,
        renderSegment: renderSegment,
        renderNewSegments: renderNewSegments,
        renderStroke: renderStroke,
        hitStroke: hitStroke
    };
})(window);
