// =============================================================================
// GRUNTER ENGINE  -  for Adobe Illustrator (ExtendScript, ES3: no let/const, JSON, forEach, indexOf on arrays)
// Run by Grunter.app through osascript with an ADAPT_JOB (see runJob). Not meant to be run by hand.
//   analyse  reads a master and describes it. Changes nothing in the document.
//   make     adds one artboard per size next to the master and copies the master's objects onto each.
//            Never saves. Undo with File > Revert (it also drops unsaved edits, so save first).
// Rules, read from how the master is built:
//   Photo      its clip mask is rebuilt to the new board; the photo is recropped around the anchor.
//   Cut-outs   photo copies with a small mask (a head in front of the headline) move with the photo.
//   Headline   headline / device / product: one block; follows the anchor (or keeps its board place).
//   Logo/legal pinned to their corner; legal keeps its exact size.
//   Panel      a side block of a split layout, fitted to its side; stacked under the photo on tall sizes.
// Roles are guessed from size and position; the app can override any of them.
// =============================================================================
#target illustrator

var EDGE_MAX_AREA = 0.06;   // edge items are smaller than this share of the master area
var EDGE_NEAR = 0.12;       // ...and within this share of the board from an edge (0.2 caught headlines)
var BG_COVER = 0.9;         // backgrounds cover at least this share of both sides
var ZOOM_LIMIT = 1.1;       // photo may zoom this much past the headline before a new photo is advised
var ZONE_MIN = 0.2;         // a split zone is at least this share of the master width
var STACK_BELOW = 1.2;      // boards narrower than this (w/h) stack the zones instead of side by side
var STACK_FIRST = 0.55;     // share of the height the first (photo) zone gets when stacked
var PANEL_CROP = 1.2;       // a panel zone is cropped to fill its slot; beyond this crop factor the report asks for a human look
var PANEL_FIT = 0.9;        // flat panels: content fills at most this share of its slot
var HERO_MARGIN = 0.04;    // hero keeps this share of the board's short side clear of each edge
var CANVAS = 8000;          // Illustrator's canvas is about +-8192pt around the origin; never place boards past this
var GAP = 400;             // pt between new artboards (room for type that runs past the edge)

// ---------- pure geometry (no Illustrator calls; tested outside Illustrator) ----------
// rect / bounds are [left, top, right, bottom] with y going UP (Illustrator convention).

function classify(b, mr, isText) {
    var W = mr[2] - mr[0], H = mr[1] - mr[3];
    var w = b[2] - b[0], h = b[1] - b[3];
    if (w >= BG_COVER * W && h >= BG_COVER * H) return "background";
    var mL = b[0] - mr[0], mR = mr[2] - b[2], mT = mr[1] - b[1], mB = b[3] - mr[3];
    var near = Math.min(mL, mR) <= EDGE_NEAR * W || Math.min(mT, mB) <= EDGE_NEAR * H;
    if (w * h <= EDGE_MAX_AREA * W * H && near) return "edge";
    return "hero";
}

// Where the copy of an edge item with master bounds b goes on target rect tr.
// Returns { s: uniform scale, left, top } for the copy's bounds.
function placeEdge(b, mr, tr, isText) {
    var W = mr[2] - mr[0], H = mr[1] - mr[3], w = tr[2] - tr[0], h = tr[1] - tr[3];
    var bw = b[2] - b[0], bh = b[1] - b[3], s;
    var sA = Math.sqrt((w * h) / (W * H));
    s = isText ? 1 : sA;
    if (bw > 0) s = Math.min(s, 0.9 * w / bw);
    if (bh > 0) s = Math.min(s, 0.9 * h / bh);
    var cx = (b[0] + b[2]) / 2 - mr[0], cy = mr[1] - (b[1] + b[3]) / 2;
    var left, top;
    if (cx < W / 3) left = tr[0] + (b[0] - mr[0]) * sA;
    else if (cx > 2 * W / 3) left = tr[2] - (mr[2] - b[2]) * sA - bw * s;
    else left = tr[0] + cx / W * w - bw * s / 2;
    if (cy < H / 3) top = tr[1] - (mr[1] - b[1]) * sA;
    else if (cy > 2 * H / 3) top = tr[3] + (b[3] - mr[3]) * sA + bh * s;
    else top = tr[1] - cy / H * h + bh * s / 2;
    return { s: s, left: left, top: top };
}

// Layout: the photo is cropped so the marked point stays where it sits in the master,
// the hero then keeps its master position relative to that point and grows with the photo as far as the board allows.
// Moving the marker therefore moves the crop on every size, not only where the photo has to be enlarged.
function layoutMarkerFirst(P, V, F, edges, mr, tr, follow, R) {
    var W = mr[2] - mr[0], H = mr[1] - mr[3], w = tr[2] - tr[0], h = tr[1] - tr[3];
    var m = HERO_MARGIN * Math.min(w, h), base = Math.min(w, h) / Math.min(W, H);
    var pw = P[2] - P[0], ph = P[1] - P[3];
    var s = Math.max(base, w / pw, h / ph);
    var tx = tr[0] + (F[0] - mr[0]) / W * w, ty = tr[1] - (mr[1] - F[1]) / H * h;      // where the marked point sits in the master, scaled to this board
    var rr = (R || 0) * s;                                                               // the anchor area on this board: kept whole inside the frame where the photo allows
    tx = 2 * rr < w ? Math.max(tr[0] + rr, Math.min(tx, tr[2] - rr)) : (tr[0] + tr[2]) / 2;   // too big for the board: centre it, as much of it shows as can
    ty = 2 * rr < h ? Math.max(tr[3] + rr, Math.min(ty, tr[1] - rr)) : (tr[1] + tr[3]) / 2;
    var left = Math.max(Math.min(tx + s * (P[0] - F[0]), tr[0]), tr[2] - s * pw);      // slide only as far as covering the board allows
    var top = Math.min(Math.max(ty + s * (P[1] - F[1]), tr[1]), tr[3] + s * ph);
    var ox = left - s * P[0], oy = top - s * P[1];
    var fx = ox + s * F[0], fy = oy + s * F[1];                                          // where the marked point really lands
    var vw = V[2] - V[0], vh = V[1] - V[3], vcx = (V[0] + V[2]) / 2, vcy = (V[1] + V[3]) / 2;
    // follow: the hero keeps its master offset from the marker and grows with the photo.
    // not follow: the hero keeps its master place on the board (as in hero-first); the marker only steers the photo crop.
    var sh = Math.min(follow ? s : base, (w - 2 * m) / vw, (h - 2 * m) / vh), hx, hy, nv, i, hit;
    var bcx = tr[0] + (vcx - mr[0]) / W * w, bcy = tr[1] - (mr[1] - vcy) / H * h;
    for (var tries = 0; tries < 20; tries++) {
        var cx = follow ? fx + sh * (vcx - F[0]) : bcx, cy = follow ? fy + sh * (vcy - F[1]) : bcy;
        var l = Math.max(tr[0] + m, Math.min(cx - sh * vw / 2, tr[2] - m - sh * vw));
        var t = Math.min(tr[1] - m, Math.max(cy + sh * vh / 2, tr[3] + m + sh * vh));
        hx = l - sh * V[0]; hy = t - sh * V[1];
        nv = [l, t, l + sh * vw, t - sh * vh];
        for (hit = false, i = 0; i < edges.length; i++) if (overlaps(nv, edges[i])) hit = true;
        if (!hit) break;
        sh *= 0.95;
    }
    var cut = rr > 0 && (fx - rr < tr[0] - 0.5 || fx + rr > tr[2] + 0.5 || fy - rr < tr[3] - 0.5 || fy + rr > tr[1] + 0.5);
    return { sh: sh, hx: hx, hy: hy, s: s, ox: ox, oy: oy, hero: nv, clash: hit, cut: cut,
             zoom: s / base, drift: Math.sqrt((fx - tx) * (fx - tx) + (fy - ty) * (fy - ty)) };
}

function overlaps(a, b) { return a[0] < b[2] && b[0] < a[2] && a[3] < b[1] && b[3] < a[1]; }

// Focal point = centre of an object named "focal", else of the largest non-text hero object.
function pickFocal(items, mr) {   // items: [{b, kind, isText, name}] -> { p: [x, y], main: bounds|null }
    var i, best = null, a, ba = -1, it, named = null;
    for (i = 0; i < items.length; i++) {
        it = items[i];
        if (/^focal$/i.test(it.name) || it.kind === "focal") named = it.b;
        if (it.kind !== "hero" || it.isText) continue;
        a = area(it.b);
        if (a > ba) { ba = a; best = it.b; }
    }
    var r = named || best || mr;
    return { p: [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], main: best };
}

// Role tags written by Adapt Tag into the object's Attributes note ("adapt:<role>").
var KIND_OF = { photo: "background", cutout: "background", headline: "hero", panel: "hero", logo: "edge", legal: "edge", decor: "decor", focal: "focal" };
function getTag(item) {
    var m; try { m = String(item.note || "").match(/adapt:(\w+)/); } catch (e) { m = null; }
    return m && KIND_OF[m[1]] ? m[1] : "";
}

function area(b) { return (b[2] - b[0]) * (b[1] - b[3]); }

// ---------- Illustrator part ----------
function isClipPath(it) {
    try { return it.typename === "CompoundPathItem" ? it.pathItems[0].clipping : !!it.clipping; } catch (e) { return false; }
}

// Bounds of what is inside a clip mask (the whole photo), or the item itself.
function contentBounds(item) {
    if (item.typename !== "GroupItem" || !item.clipped) return item.visibleBounds;
    var u = null, i, b, c;
    for (i = 0; i < item.pageItems.length; i++) {
        c = item.pageItems[i];
        if (isClipPath(c)) continue;
        b = c.visibleBounds;
        u = u ? [Math.min(u[0], b[0]), Math.max(u[1], b[1]), Math.max(u[2], b[2]), Math.min(u[3], b[3])] : b;
    }
    return u || item.visibleBounds;
}

function maskBounds(item) {
    if (item.typename !== "GroupItem" || !item.clipped) return null;
    for (var i = 0; i < item.pageItems.length; i++) if (isClipPath(item.pageItems[i])) return item.pageItems[i].visibleBounds;
    return null;
}

// Real extents of a headline. Only text on a path needs outlining: it reports its whole path, not its letters.
// Everything else keeps its own bounds, so a read adds no temporary copies to the file.
function visualBounds(item) {
    if (item.typename !== "TextFrame" || item.kind !== TextType.PATHTEXT) return item.visibleBounds;
    var copy = null, outlined = null, key = null, cache = $.global.gruntOutlineCache || ($.global.gruntOutlineCache = {}), vb;
    // shortcut: the key does not see a font change that leaves path, text and size alone; restart Illustrator to clear the cache
    try { if (item.uuid) key = item.uuid + "|" + item.visibleBounds.join(",") + "|" + item.contents + "|" + item.textRange.characterAttributes.size; } catch (e0) { key = null; }
    if (key && cache[key]) return cache[key];
    try {
        copy = item.duplicate();
        outlined = copy.createOutline();
        vb = outlined.visibleBounds;
        if (key) cache[key] = vb;
        return vb;
    } catch (e) {
        return item.visibleBounds;
    } finally {
        try { (outlined || copy).remove(); } catch (e2) {}   // never leave the temporary copy in the file
    }
}

function r(a) { var o = [], i; for (i = 0; i < a.length; i++) o.push(Math.round(a[i])); return "[" + o.join(",") + "]"; }

// Scale a copy by s, then move it so its bounds' top-left lands on (left, top).
// byContent: align on what is inside its clip mask (for cut-outs, whose master bounds were the content).
function moveTo(dup, s, left, top, byContent) {
    if (Math.abs(s - 1) > 1e-4) dup.resize(s * 100, s * 100, true, true, true, true, s * 100, Transformation.CENTER);
    var nb = byContent ? contentBounds(dup) : dup.visibleBounds;
    dup.translate(left - nb[0], top - nb[1]);
}

// Turn a copied background into "photo inside a mask the exact size of board tr".
function makePhoto(dup, pl, tr, label) {
    // fresh group: editing an existing clip group's mask in place is unreliable in Illustrator
    var g = dup.parent.groupItems.add(), i, c;
    g.move(dup, ElementPlacement.PLACEBEFORE);
    if (dup.typename === "GroupItem" && dup.clipped) {
        for (i = dup.pageItems.length - 1; i >= 0; i--) {   // bottom-up keeps stacking order
            c = dup.pageItems[i];
            if (!isClipPath(c)) c.move(g, ElementPlacement.PLACEATBEGINNING);
        }
        dup.remove();   // only the copy's old mask is left in it
    } else {
        dup.move(g, ElementPlacement.PLACEATEND);
    }
    if (Math.abs(pl.s - 1) > 1e-4) g.resize(pl.s * 100, pl.s * 100, true, true, true, true, pl.s * 100, Transformation.CENTER);
    var nb = g.visibleBounds;
    g.translate(pl.left - nb[0], pl.top - nb[1]);
    // created at document level, then moved in: group.pathItems.rectangle does not land inside the group
    var mask = app.activeDocument.pathItems.rectangle(tr[1], tr[0], tr[2] - tr[0], tr[1] - tr[3]);
    mask.move(g, ElementPlacement.PLACEATBEGINNING);
    g.clipped = true;
    g.name = "Photo " + label;
}

// Attached photo for one board: placed linked, scaled to cover the board, centred, in a board-size mask.
function makePlatePhoto(masterPhoto, file, tr, label) {
    var g = masterPhoto.parent.groupItems.add();
    g.move(masterPhoto, ElementPlacement.PLACEBEFORE);
    var p = app.activeDocument.placedItems.add();
    p.file = file;
    p.move(g, ElementPlacement.PLACEATEND);
    var b = p.visibleBounds, pw = b[2] - b[0], ph = b[1] - b[3], w = tr[2] - tr[0], h = tr[1] - tr[3];
    var s = Math.max(w / pw, h / ph);
    p.resize(s * 100, s * 100, true, true, true, true, s * 100, Transformation.CENTER);
    var nb = p.visibleBounds;
    p.translate(tr[0] + (w - pw * s) / 2 - nb[0], tr[1] - (h - ph * s) / 2 - nb[1]);
    var mask = app.activeDocument.pathItems.rectangle(tr[1], tr[0], w, h);
    mask.move(g, ElementPlacement.PLACEATBEGINNING);
    g.clipped = true;
    g.name = "Photo " + label;
}

function orientationOf(w, h) {
    var a = w / h;   // no chained ?: here: ExtendScript evaluates a ? b : c ? d : e left to right
    if (a >= 2.5) return "ultra-wide";
    if (a >= 1.2) return "landscape";
    if (a > 0.85) return "square";
    return "portrait";
}

// Split layouts: clipped groups whose mask is a full-height strip (e.g. photo left, product panel right).
// Returns zones sorted left to right with contiguous [L, R] ranges, or [] when the master is not split.
function findZones(raw, mr) {
    var W = mr[2] - mr[0], H = mr[1] - mr[3], zones = [], i, mb, it;
    for (i = 0; i < raw.length; i++) {
        it = raw[i];
        if (it.item.typename !== "GroupItem" || !it.item.clipped) continue;
        mb = maskBounds(it.item);
        if (!mb) continue;
        var w = mb[2] - mb[0], h = mb[1] - mb[3];
        if (h >= BG_COVER * H && w >= ZONE_MIN * W && w < BG_COVER * W) zones.push({ raw: it, L: mb[0], R: mb[2] });
    }
    if (zones.length === 1) {
        // one clipped photo strip (e.g. photo on the left 60%): the rest of the board is the panel
        var z = zones[0], gapL = z.L - mr[0], gapR = mr[2] - z.R;
        if (Math.max(gapL, gapR) < ZONE_MIN * W) return [];
        if (gapR >= gapL) { z.L = mr[0]; zones = [z, { raw: null, L: z.R, R: mr[2] }]; zones.panel = 1; }
        else { z.R = mr[2]; zones = [{ raw: null, L: mr[0], R: z.L }, z]; zones.panel = 0; }
        return zones;
    }
    if (zones.length < 2) return [];
    zones.sort(function (a, b) { return a.L - b.L; });
    zones[0].L = mr[0]; zones[zones.length - 1].R = mr[2];
    for (i = 0; i + 1 < zones.length; i++) zones[i].R = zones[i + 1].L = (zones[i].R + zones[i + 1].L) / 2;
    return zones;
}

// Where each region goes on target board tr. Wide boards keep the side-by-side split in the
// master's proportions; tall/square boards stack the zones (first zone on top).
function targetRects(regions, tr, split) {
    var w = tr[2] - tr[0], h = tr[1] - tr[3], out = [], i, pos = 0, n = regions.length;
    if (!split) return [tr];
    var side = w / h >= STACK_BELOW;
    for (i = 0; i < n; i++) {
        var span = side ? regions[i].frac * w : (i === 0 ? STACK_FIRST : (1 - STACK_FIRST) / (n - 1)) * h;
        if (i === n - 1) span = (side ? w : h) - pos;   // last zone takes the rounding
        out.push(side ? [tr[0] + pos, tr[1], tr[0] + pos + span, tr[3]] : [tr[0], tr[1] - pos, tr[2], tr[1] - pos - span]);
        pos += span;
    }
    return out;
}

// Where the next board goes. pos: { x0, x, y, rowH, top, right, moved } is advanced by the caller as boards are added.
// Rows run left to right below the lowest board. When the canvas bottom is reached, one new column starts at the top, right of everything.
function nextBoard(pos, w, h) {
    if (pos.x > pos.x0 && pos.x + w > CANVAS) { pos.x = pos.x0; pos.y -= pos.rowH + GAP; pos.rowH = 0; }   // wrap before the canvas edge: an off-canvas add can wedge the file's artboards
    if (pos.y - h < -CANVAS && !pos.moved) { pos.moved = true; pos.x0 = pos.x = pos.right + GAP; pos.y = pos.top; pos.rowH = 0; }
    if (pos.y - h < -CANVAS || pos.x + w > CANVAS) return null;
    return [pos.x, pos.y, pos.x + w, pos.y - h];
}

// Centre of a panel crop: the anchor's spot, kept where the slot stays covered. mr: zone rect, tw/th: slot size, su: scale, p: anchor.
function cropCentre(mr, tw, th, su, p) {
    var hx = tw / su / 2, hy = th / su / 2;
    return [Math.max(mr[0] + hx, Math.min(p[0], mr[2] - hx)), Math.max(mr[3] + hy, Math.min(p[1], mr[1] - hy))];
}

// Unlock an item and every layer or group around it (a locked parent blocks a copy even when the item is free); relock afterwards.
function unlockChain(it) {
    var out = [], p = it;
    while (p && p.typename !== "Document") { try { if (p.locked) { out.push(p); p.locked = false; } } catch (e) {} p = p.parent; }
    return out;
}
function relock(list) { for (var i = 0; i < list.length; i++) try { list[i].locked = true; } catch (e) {} }
// Names a failed item so the log says which one it was: role, type, size and place on the master, layer.
function who(x) {
    var role = x.kind + (x.cutout ? " cut-out" : "") + (x.tag ? " [" + x.tag + "]" : "");
    return role + " " + x.item.typename + (x.name ? " '" + x.name + "'" : "") + " " + r(x.b) + layerOf(x.item);
}
function layerOf(it) { try { return ' (layer "' + it.layer.name + '")'; } catch (e) { return ""; } }

// Adds an artboard and checks it is really there at tr: Illustrator can refuse silently past the canvas edge.
function addBoard(doc, tr) {
    var n = doc.artboards.length, ab = null, q;
    try { doc.artboards.add(tr); } catch (e) { return null; }
    if (doc.artboards.length !== n + 1) return null;
    ab = doc.artboards[n];
    q = ab.artboardRect;
    for (var i = 0; i < 4; i++) if (Math.abs(q[i] - tr[i]) > 1) { try { ab.remove(); } catch (e2) {} return null; }
    return ab;
}

// Top-level objects whose centre sits on the master artboard, in a stable order (their id is the index).
function collectRaw(doc, mr, roles) {
    var raw = [], skipped = 0;
    function collect(layer) {
        if (!layer.visible || layer.locked) { skipped++; return; }
        var i, it, b;
        for (i = 0; i < layer.pageItems.length; i++) {
            it = layer.pageItems[i];
            try { if (it.guides) continue; } catch (e) {}
            b = it.visibleBounds;
            var cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
            if (cx < mr[0] || cx > mr[2] || cy > mr[1] || cy < mr[3]) continue;
            var id = raw.length, tag = getTag(it);
            if (roles && roles.hasOwnProperty(String(id))) tag = KIND_OF[roles[String(id)]] ? roles[String(id)] : "";   // role chosen in the tool wins; "auto" clears
            raw.push({ id: id, item: it, b: b, isText: it.typename === "TextFrame", name: it.name, tag: tag });
        }
        for (i = 0; i < layer.layers.length; i++) collect(layer.layers[i]);
    }
    for (var L = 0; L < doc.layers.length; L++) collect(doc.layers[L]);
    return { raw: raw, skipped: skipped };
}

// Reads the master: objects, split zones, roles, focal point. Changes nothing.
// focalAt: optional [x, y] in pt from the artboard's top-left (clicked in the tool); overrides the focal point.
function analyseMaster(doc, mi, focalAt, roles, follow) {
    var mr = doc.artboards[mi].artboardRect;
    var W = mr[2] - mr[0], H = mr[1] - mr[3];
    var got = collectRaw(doc, mr, roles), raw = got.raw, skipped = got.skipped;
    if (!raw.length) return { error: "No objects found on the master artboard." };
    var fo = focalAt ? [mr[0] + focalAt[0], mr[1] - focalAt[1]] : null;

    // regions: the whole master, or one per zone of a split layout
    var zones = findZones(raw, mr), regions = [], k, j, it, panelAt = zones.panel >= 0 ? zones.panel : -1;
    if (!zones.length) {
        // no clipped zones: objects tagged Panel define the split (e.g. a plain coloured panel beside the photo)
        var pu = null;
        for (k = 0; k < raw.length; k++) if (raw[k].tag === "panel") {
            var pb = raw[k].b;
            pu = pu ? [Math.min(pu[0], pb[0]), 0, Math.max(pu[2], pb[2]), 0] : [pb[0], 0, pb[2], 0];
        }
        if (pu) {
            var pl0 = Math.max(mr[0], pu[0]), pr0 = Math.min(mr[2], pu[2]);
            if ((pl0 + pr0) / 2 > (mr[0] + mr[2]) / 2) { zones = [{ raw: null, L: mr[0], R: pl0 }, { raw: null, L: pl0, R: mr[2] }]; panelAt = 1; }
            else { zones = [{ raw: null, L: mr[0], R: pr0 }, { raw: null, L: pr0, R: mr[2] }]; panelAt = 0; }
            if (zones[0].R - zones[0].L < ZONE_MIN * W || zones[1].R - zones[1].L < ZONE_MIN * W) { zones = []; panelAt = -1; }   // panel covers (almost) everything
        }
    }
    if (zones.length) {
        for (k = 0; k < zones.length; k++) regions.push({ mr: [zones[k].L, mr[1], zones[k].R, mr[3]], items: [], zoneBg: zones[k].raw });
    } else regions.push({ mr: mr, items: [], zoneBg: null });
    for (k = 0; k < raw.length; k++) {
        it = raw[k];
        var ri = 0, cxm = (it.b[0] + it.b[2]) / 2;
        var fullBoard = it.b[2] - it.b[0] >= BG_COVER * W && it.b[1] - it.b[3] >= BG_COVER * H;
        if (panelAt >= 0 && it.tag === "panel") ri = panelAt;          // tagged roles win over position
        else if (panelAt >= 0 && it.tag === "photo") ri = 1 - panelAt;
        else if (panelAt >= 0 && fullBoard && !(zones[0].raw === it || zones[1].raw === it)) ri = panelAt;   // full-board backdrop: the photo covers it, the panel shows it
        else for (j = 0; j < regions.length; j++) {
            if (regions[j].zoneBg === it) { ri = j; break; }
            if (cxm >= regions[j].mr[0]) ri = j;
        }
        regions[ri].items.push(it);
    }

    var items = [], mainRegion = null;
    for (j = 0; j < regions.length; j++) {
        var rg = regions[j], rmr = rg.mr, rW = rmr[2] - rmr[0], rH = rmr[1] - rmr[3];
        rg.frac = rW / W; rg.mainBg = null;
        for (k = 0; k < rg.items.length; k++) {
            it = rg.items[k];
            it.keepSize = it.tag === "legal" || (!it.tag && it.isText);
            it.kind = rg.zoneBg === it ? "background" : (KIND_OF[it.tag] || classify(it.b, rmr, it.isText));
            items.push(it);
            if (it.kind !== "background") continue;
            it.P = contentBounds(it.item);
            // a mask much smaller than the board is a cut-out (e.g. head/hand popping in front of the
            // headline): keep it. A board-size (or zone-size) mask is the background: rebuilt per board.
            var mb = maskBounds(it.item);
            it.cutout = rg.zoneBg !== it && (it.tag === "cutout" ||
                (it.tag !== "photo" && !!mb && ((mb[2] - mb[0]) < BG_COVER * rW || (mb[1] - mb[3]) < BG_COVER * rH)));
            if (!it.cutout && (!rg.mainBg || area(it.P) > area(rg.mainBg.P))) rg.mainBg = it;
        }
        for (k = 0; !rg.mainBg && k < rg.items.length; k++) if (rg.items[k].kind === "background") rg.mainBg = rg.items[k];
        if (rg.zoneBg) rg.mainBg = rg.zoneBg;   // a zone's own clipped photo is its background
        rg.focal = pickFocal(rg.items, rmr);
        if (fo && fo[0] >= rmr[0] && fo[0] <= rmr[2]) rg.focal = { p: fo, main: rg.focal.main, r: Math.max(0, focalAt[2] || 0), set: true };   // focal clicked in the tool
        // hero's real visual extent (text on a path reports its whole path, not the letters)
        var V = null, vb;
        for (k = 0; k < rg.items.length; k++) {
            if (rg.items[k].kind !== "hero") continue;
            vb = visualBounds(rg.items[k].item);
            if (vb[2] - vb[0] <= 0 && vb[1] - vb[3] <= 0) continue;
            V = V ? [Math.min(V[0], vb[0]), Math.max(V[1], vb[1]), Math.max(V[2], vb[2]), Math.min(V[3], vb[3])] : vb;
        }
        rg.V = V || [rg.focal.p[0] - 1, rg.focal.p[1] + 1, rg.focal.p[0] + 1, rg.focal.p[1] - 1];
        if (rg.mainBg && (!mainRegion || area(rg.mainBg.P) > area(mainRegion.mainBg.P))) mainRegion = rg;   // the photo zone
    }
    if (panelAt >= 0) mainRegion = regions[1 - panelAt];   // tagged split: the non-panel zone is the photo zone
    var split = zones.length > 0;

    function edgesOn(rg, rtr) {   // logo/legal placed first, so the hero can stay clear of them
        var out = [], ep, e;
        for (var q = 0; q < rg.items.length; q++) {
            e = rg.items[q];
            if (e.kind !== "edge") continue;
            ep = placeEdge(e.b, rg.mr, rtr, e.keepSize);
            e.pl = ep;
            out.push([ep.left, ep.top, ep.left + ep.s * (e.b[2] - e.b[0]), ep.top - ep.s * (e.b[1] - e.b[3])]);
        }
        return out;
    }
    function layoutFor(rg, rtr) { return layoutMarkerFirst(rg.mainBg ? rg.mainBg.P : rg.mr, rg.V, rg.focal.p, edgesOn(rg, rtr), rg.mr, rtr, follow !== false, rg.focal.r); }
    function needsPhoto(w, h) {
        var tr0 = [0, h, w, 0], rs = targetRects(regions, tr0, split), q = 0;
        while (q < regions.length && regions[q] !== mainRegion) q++;
        return !!mainRegion && !!mainRegion.mainBg && layoutFor(mainRegion, rs[q]).zoom > ZOOM_LIMIT;
    }


    return { doc: doc, mi: mi, mr: mr, W: W, H: H, raw: raw, skipped: skipped, regions: regions, items: items,
             mainRegion: mainRegion, split: split, edgesOn: edgesOn, layoutFor: layoutFor, needsPhoto: needsPhoto };
}

function readingOf(M) {
    var cnt = { background: 0, hero: 0, edge: 0, decor: 0, focal: 0 }, tagged = 0, k;
    for (k = 0; k < M.items.length; k++) { cnt[M.items[k].kind]++; if (M.items[k].tag) tagged++; }
    return (M.split ? "SPLIT layout, " + M.regions.length + " zones. " : "") + "photo " + cnt.background + ", headline/panel " + cnt.hero +
        ", logo/legal " + cnt.edge + ", decor " + cnt.decor + ", subject marker " + cnt.focal + "  (" + tagged + " tagged, " + (M.items.length - tagged) + " guessed)";
}

// Builds one artboard per size next to the master. sizes: [{ w, h, label, plate: File|null }].
function makeAdapts(M, sizes) {
    var doc = M.doc, mi = M.mi, mr = M.mr, regions = M.regions, items = M.items, mainRegion = M.mainRegion, split = M.split;
    var layoutFor = M.layoutFor, j, k, it;
    var log = ["Adapt Maker log  " + new Date(), "master " + doc.artboards[mi].name + " rect " + r(mr) + (split ? "  SPLIT" : "")];
    for (j = 0; j < regions.length; j++) {
        log.push("region " + j + " rect " + r(regions[j].mr) + " focal " + r(regions[j].focal.p) + " hero visual " + r(regions[j].V) +
                 " photo " + (regions[j].mainBg ? r(regions[j].mainBg.P) : "none"));
        for (k = 0; k < regions[j].items.length; k++) {
            it = regions[j].items[k];
            log.push("  " + it.kind + (it.cutout ? " (cut-out)" : "") + (it.tag ? " [tag " + it.tag + "]" : " [guessed]") + "  " + it.item.typename + " '" + it.name + "'  " + r(it.b));
        }
    }

    // new artboards go in rows below everything that exists
    var minBottom = mr[3], maxRight = mr[2], FULL = "the canvas is full of earlier adapts. Save, then use File > Revert (it drops unsaved edits), or delete old boards, then Make again.";
    for (k = 0; k < doc.artboards.length; k++) {
        minBottom = Math.min(minBottom, doc.artboards[k].artboardRect[3]);
        maxRight = Math.max(maxRight, doc.artboards[k].artboardRect[2]);
    }
    var pos = { x0: mr[0], x: mr[0], y: minBottom - GAP, rowH: 0, top: mr[1], right: maxRight, moved: false };
    var made = [], errors = [], warnings = [], usedMasters = {};

    for (var t = 0; t < sizes.length; t++) {
        var sz = sizes[t];
        var MM = sz.M || M;   // each size can come from its own master (e.g. a tall master for tall sizes)
        mr = MM.mr; regions = MM.regions; items = MM.items; mainRegion = MM.mainRegion; split = MM.split; layoutFor = MM.layoutFor;
        if (!usedMasters[MM.mi]) {
            usedMasters[MM.mi] = true;
            if (MM !== M) {
                log.push("master " + doc.artboards[MM.mi].name + " rect " + r(mr) + (split ? "  SPLIT" : ""));
                for (j = 0; j < regions.length; j++) log.push("region " + j + " rect " + r(regions[j].mr) + " focal " + r(regions[j].focal.p) + " hero visual " + r(regions[j].V));
            }
        }
        log.push(sz.label + " <- master " + doc.artboards[MM.mi].name);
        var tr = nextBoard(pos, sz.w, sz.h), ab = tr ? addBoard(doc, tr) : null;
        if (tr && !ab && pos.x > pos.x0) {   // past the canvas edge: start a new row and try once more
            pos.x = pos.x0; pos.y -= pos.rowH + GAP; pos.rowH = 0;
            tr = nextBoard(pos, sz.w, sz.h); ab = tr ? addBoard(doc, tr) : null;
        }
        if (!ab) { errors.push(sz.label + ": " + FULL); continue; }
        try { ab.name = sz.label; } catch (e) {   // e.g. a board with that name is already in the file
            try { ab.name = sz.label + " (" + doc.artboards.length + ")"; } catch (e2) { warnings.push(sz.label + ": could not name the artboard"); }
        }
        pos.x += sz.w + GAP; pos.rowH = Math.max(pos.rowH, sz.h); pos.right = Math.max(pos.right, tr[2]);

        var rects = targetRects(regions, tr, split);
        for (j = 0; j < regions.length; j++) {
            var rg2 = regions[j], rtr = rects[j], plate = rg2 === mainRegion ? sz.plate : null;
            if (split && rg2 !== mainRegion) {   // panel zone: everything in it (image + text on top) scales as one rigid unit
                var zw = rg2.mr[2] - rg2.mr[0], zh = rg2.mr[1] - rg2.mr[3], tw = rtr[2] - rtr[0], th = rtr[1] - rtr[3];
                var cover = Math.max(tw / zw, th / zh), contain = Math.min(tw / zw, th / zh);
                var su = cover;   // full-bleed, centred: no empty space. Shrinking to fit would leave blank bands
                var cxm = (rg2.mr[0] + rg2.mr[2]) / 2, cym = (rg2.mr[1] + rg2.mr[3]) / 2, cxt = (rtr[0] + rtr[2]) / 2, cyt = (rtr[1] + rtr[3]) / 2;
                // plain-shape backdrop (e.g. a flat red panel): stretch the backdrop to the slot, fit the content inside uncropped
                var backs = 0, flat = true, cu = null;
                for (q = 0; q < rg2.items.length; q++) {
                    var pb2 = rg2.items[q].b, tn = rg2.items[q].item.typename;
                    rg2.items[q].backdrop = pb2[2] - pb2[0] >= BG_COVER * zw && pb2[1] - pb2[3] >= BG_COVER * zh;
                    if (rg2.items[q].backdrop) { backs++; if (tn !== "PathItem" && tn !== "CompoundPathItem") flat = false; }
                    else if (rg2.items[q].kind !== "focal" && rg2.items[q].kind !== "decor") {
                        var cb2 = [Math.max(pb2[0], rg2.mr[0]), Math.min(pb2[1], rg2.mr[1]), Math.min(pb2[2], rg2.mr[2]), Math.max(pb2[3], rg2.mr[3])];
                        cu = cu ? [Math.min(cu[0], cb2[0]), Math.max(cu[1], cb2[1]), Math.max(cu[2], cb2[2]), Math.min(cu[3], cb2[3])] : cb2;
                    }
                }
                var stretch = backs > 0 && flat && cu;
                if (stretch) {
                    su = Math.min(tw / (cu[2] - cu[0]), th / (cu[1] - cu[3])) * PANEL_FIT;
                    cxm = (cu[0] + cu[2]) / 2; cym = (cu[1] + cu[3]) / 2;
                    log.push(ab.name + " zone " + j + ": flat panel stretched, content scale " + su.toFixed(3));
                } else {
                    log.push(ab.name + " zone " + j + ": panel scale " + su.toFixed(3) + ", crop " + (cover / contain).toFixed(2) + "x");
                    if (rg2.focal.set) { var cc = cropCentre(rg2.mr, tw, th, su, rg2.focal.p); cxm = cc[0]; cym = cc[1]; }   // an anchor placed in this zone steers its crop
                    if (cover / contain > PANEL_CROP) warnings.push(sz.label + ": panel cropped about " + Math.round((1 - contain / cover) * 100) + "% to fit. Check the product is fully visible.");
                }
                var pg = rg2.items[0].item.parent.groupItems.add(), first = true;
                for (var q = 0; q < rg2.items.length; q++) {
                    var ps = rg2.items[q];
                    if (ps.kind === "focal") continue;
                    var plk = [];
                    try {
                        plk = unlockChain(ps.item);
                        var pd = ps.item.duplicate(ps.item, ElementPlacement.PLACEBEFORE);
                        relock(plk);
                        if (stretch && ps.backdrop) {   // flat shape: stretch with the slot (zone edges map to slot edges)
                            var sx = tw / zw, sy = th / zh;
                            pd.resize(sx * 100, sy * 100, true, true, true, true, Math.min(sx, sy) * 100, Transformation.CENTER);
                            var nb2 = pd.visibleBounds;
                            pd.translate(rtr[0] + (ps.b[0] - rg2.mr[0]) * sx - nb2[0], rtr[1] - (rg2.mr[1] - ps.b[1]) * sy - nb2[1]);
                        } else moveTo(pd, su, cxt + su * (ps.b[0] - cxm), cyt + su * (ps.b[1] - cym), false);
                        if (first) { pg.move(pd, ElementPlacement.PLACEBEFORE); first = false; }
                        pd.move(pg, ElementPlacement.PLACEATEND);
                    } catch (e) {
                        relock(plk);
                        errors.push(sz.label + ": " + who(ps) + " - " + e.message);
                    }
                }
                try {
                    var pm = app.activeDocument.pathItems.rectangle(rtr[1], rtr[0], tw, th);
                    pm.move(pg, ElementPlacement.PLACEATBEGINNING);
                    pg.clipped = true; pg.name = "Panel " + sz.label;
                } catch (e) { errors.push(sz.label + ": could not mask the panel - " + e.message); }
                continue;
            }
            var Lt = layoutFor(rg2, rtr);
            log.push(ab.name + (split ? " zone " + j : "") + ": " + orientationOf(sz.w, sz.h) + ", hero scale " + Lt.sh.toFixed(3) +
                     (plate ? ", attached photo " + plate.fsName : ", photo scale " + Lt.s.toFixed(3)));
            if (plate) warnings.push(sz.label + ": your photo is centred. Nudge it so the face sits where you want it.");
            else if (rg2 === mainRegion) {
                if (Lt.zoom > ZOOM_LIMIT) warnings.push(sz.label + ": photo enlarged " + Lt.zoom.toFixed(1) + "x to fill the frame and may look soft. A taller or wider photo will fix it.");
                if (Lt.cut) warnings.push(sz.label + ": the circle around the anchor is too big for this size, so part of it is cropped. Make the circle smaller.");
                if (Lt.drift > 20) warnings.push(sz.label + ": the photo has no room to move, so the anchor sits " + Math.round(Lt.drift) + " pt from where you put it. A larger photo would fix this.");
            }
            if (Lt.clash) warnings.push(sz.label + (split ? " zone " + j : "") + ": headline touches the logo or legal text.");

            for (var i = 0; i < rg2.items.length; i++) {
                var src = rg2.items[i], lk = [];
                if (src.kind === "focal") continue;   // subject marker: used for the crop, never copied
                try {
                    if (src.kind === "background" && plate) {
                        // the master's photo (and its cut-outs) don't match an attached photo: use only the new one
                        if (src === rg2.mainBg) makePlatePhoto(src.item, plate, rtr, sz.label);
                        continue;
                    }
                    lk = unlockChain(src.item);
                    var dup = src.item.duplicate(src.item, ElementPlacement.PLACEBEFORE); // keeps stacking order
                    relock(lk);
                    if (src.kind === "background") {
                        var pl = { s: Lt.s, left: Lt.ox + Lt.s * src.P[0], top: Lt.oy + Lt.s * src.P[1] };
                        if (src.cutout) moveTo(dup, pl.s, pl.left, pl.top, true);
                        else makePhoto(dup, pl, rtr, sz.label + (split ? " zone " + j : ""));
                    } else if (src.kind === "decor") {   // bubbles, dividers: ride with the photo, never part of the headline block
                        moveTo(dup, Lt.s, Lt.ox + Lt.s * src.b[0], Lt.oy + Lt.s * src.b[1], false);
                    } else if (src.kind === "hero") {
                        moveTo(dup, Lt.sh, Lt.hx + Lt.sh * src.b[0], Lt.hy + Lt.sh * src.b[1], false);
                    } else {
                        moveTo(dup, src.pl.s, src.pl.left, src.pl.top, false);
                    }
                } catch (e) {
                    relock(lk);
                    errors.push(sz.label + ": " + who(src) + " - " + e.message);
                }
            }
        }
        made.push(ab.name);
    }

    var n = { background: 0, hero: 0, edge: 0, decor: 0, focal: 0 };
    items = M.items;
    for (k = 0; k < items.length; k++) n[items[k].kind]++;
    if (warnings.length) log.push("check by eye:\n  " + warnings.join("\n  "));
    if (errors.length) log.push("problems:\n  " + errors.join("\n  "));
    var dir; try { dir = doc.fullName.parent; } catch (e) { dir = Folder.desktop; }   // unsaved docs have no folder
    var logFile = new File(dir.fsName + "/" + doc.name.replace(/\.[^.]+$/, "") + "_adapt_log.txt");
    try { logFile.encoding = "UTF-8"; logFile.lineFeed = "Unix"; logFile.open("w"); logFile.write(log.join("\n")); logFile.close(); } catch (e) {}
    return { made: made, warnings: warnings, errors: errors, log: logFile.fsName,
             perBoard: items.length - n.focal, counts: n, skipped: M.skipped };
}

// ---------- tool mode: driven by the Adapt Tool app through ADAPT_JOB ----------
function toJSON(v) {
    var i, out, t = typeof v;
    if (v === null || v === undefined) return "null";
    if (t === "number") return isFinite(v) ? String(Math.round(v * 1000) / 1000) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "string") return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/[\x00-\x1f]/g, " ") + '"';
    if (v instanceof Array) { out = []; for (i = 0; i < v.length; i++) out.push(toJSON(v[i])); return "[" + out.join(",") + "]"; }
    out = [];
    for (i in v) if (v.hasOwnProperty(i) && typeof v[i] !== "function") out.push(toJSON(String(i)) + ":" + toJSON(v[i]));
    return "{" + out.join(",") + "}";
}

function writeText(path, text) {
    var f = new File(path);
    f.encoding = "UTF-8"; f.lineFeed = "Unix";
    f.open("w"); f.write(text); f.close();
}

// Preview of the master artboard for the tool (does not change the document).
function exportPng(doc, mi, path, W) {
    var prev = doc.artboards.getActiveArtboardIndex();   // exporting needs the artboard active; put the designer's selection back after
    doc.artboards.setActiveArtboardIndex(mi);
    var o = new ExportOptionsPNG24();
    o.artBoardClipping = true; o.antiAliasing = true; o.transparency = false;
    o.horizontalScale = o.verticalScale = Math.min(100, 1600 / W * 100);
    try { doc.exportFile(new File(path), ExportType.PNG24, o); } finally { doc.artboards.setActiveArtboardIndex(prev); }
}

// With job.runs set (the app's temporary folder, emptied when it quits) every Make leaves a folder there: the job sent,
// the result and log, and a PNG of the master and of each new adapt, so runs can be compared. Reads the document only.
function recordRun(doc, mi, from, job, res) {
    var d = new Date(), i, rect;
    function p(n) { return (n < 10 ? "0" : "") + n; }
    var runs = new Folder(job.runs);
    if (!runs.exists) runs.create();
    var dir = new Folder(runs.fsName + "/" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()));
    dir.create();
    writeText(dir.fsName + "/job.json", toJSON(job));
    writeText(dir.fsName + "/result.json", toJSON(res));
    if (res.log) new File(res.log).copy(dir.fsName + "/log.txt");
    rect = doc.artboards[mi].artboardRect;
    exportPng(doc, mi, dir.fsName + "/00 master.png", rect[2] - rect[0]);
    for (i = from; i < doc.artboards.length; i++) {
        rect = doc.artboards[i].artboardRect;
        exportPng(doc, i, dir.fsName + "/" + p(i - from + 1) + " " + doc.artboards[i].name.replace(/[\/:*?"<>|]/g, "-") + ".png", rect[2] - rect[0]);
    }
    return dir.fsName;
}

// What the tool shows: the master's objects (pt from the artboard's top-left), roles, zones, focal, photo checks.
function describe(M, checks) {
    var mr = M.mr, out = { reading: readingOf(M), split: M.split, items: [], regions: [], checks: [] }, i, j, it, rg;
    var rel = function (b) { return { x: b[0] - mr[0], y: mr[1] - b[1], w: b[2] - b[0], h: b[1] - b[3] }; };
    out.doc = { name: M.doc.name, path: (function () { try { return M.doc.fullName.fsName; } catch (e) { return ""; } })() };
    out.master = { index: M.mi, name: M.doc.artboards[M.mi].name, w: M.W, h: M.H };
    out.artboards = [];
    for (i = 0; i < M.doc.artboards.length; i++) {
        var ar = M.doc.artboards[i].artboardRect;
        out.artboards.push({ index: i, name: M.doc.artboards[i].name, w: ar[2] - ar[0], h: ar[1] - ar[3] });
    }
    for (j = 0; j < M.regions.length; j++) {
        rg = M.regions[j];
        out.regions.push({ box: rel(rg.mr), photo: rg === M.mainRegion, focal: { x: rg.focal.p[0] - mr[0], y: mr[1] - rg.focal.p[1] } });
        for (i = 0; i < rg.items.length; i++) {
            it = rg.items[i];
            out.items.push({ id: it.id, type: it.item.typename, name: it.name, box: rel(it.b), kind: it.kind, tag: it.tag,
                             cutout: !!it.cutout, region: j, text: it.isText ? String(it.item.contents).substr(0, 40) : "" });
        }
    }
    for (i = 0; checks && i < checks.length; i++) out.checks.push({ w: checks[i].w, h: checks[i].h, needsPhoto: M.needsPhoto(checks[i].w, checks[i].h) });
    return out;
}

// The master a size copies: the one named for it, else the one whose shape is closest (compared as ratios).
function pickMaster(Ms, w, h, forcedArtboard) {
    var best = Ms[0], bd = 1e9, i, d;
    for (i = 0; i < Ms.length; i++) {
        if (typeof forcedArtboard === "number" && Ms[i].mi === forcedArtboard) return Ms[i];
        d = Math.abs(Math.log((w / h) / (Ms[i].W / Ms[i].H)));
        if (d < bd) { bd = d; best = Ms[i]; }
    }
    return best;
}

// job: { mode: "analyse" | "make", doc: path, artboard: index, out: result path, png: preview path,
//        roles: { id: role } (kept by the app, never written to the file),
//        focal: [x, y, r] (r optional: anchor radius in pt, kept whole in frame), checks: [{ w, h }], sizes: [{ w, h, label, plate: path, master: artboard index (optional) }],
//        runs: folder to record each Make in (optional; the app empties it on quit),
//        follow: false = the headline keeps its place on the board instead of its offset from the marker (default true),
//        masters: [{ artboard, focal, roles, follow }] (make only: extra masters, e.g. a tall one) }
function runJob(job) {
    var res;
    try {
        if (app.documents.length === 0) throw new Error("Open the master file in Illustrator first.");
        var doc = app.activeDocument, i;
        if (job.doc) {
            for (i = 0; i < app.documents.length; i++) {
                var fp = ""; try { fp = app.documents[i].fullName.fsName; } catch (e) {}
                if (fp === job.doc || app.documents[i].name === job.doc) { doc = app.documents[i]; break; }
            }
            if (i === app.documents.length) throw new Error("The master file is no longer open: " + job.doc);
            app.activeDocument = doc;
        }
        var mi = typeof job.artboard === "number" ? job.artboard : doc.artboards.getActiveArtboardIndex();
        if (mi < 0 || mi >= doc.artboards.length) throw new Error("Artboard " + mi + " does not exist.");
        var M = analyseMaster(doc, mi, job.focal || null, job.roles || null, job.follow);
        if (M.error) throw new Error(M.error);
        if (job.mode === "make") {
            // masters: [{ artboard, focal, roles }]; the first is the main one. Each size may name one (master: index),
            // otherwise it uses the master whose shape is closest to its own.
            var Ms = [M], mm;
            for (i = 0; job.masters && i < job.masters.length; i++) {
                mm = job.masters[i];
                if (mm.artboard === mi) { Ms[0] = M; continue; }
                if (mm.artboard < 0 || mm.artboard >= doc.artboards.length) throw new Error("Artboard " + mm.artboard + " does not exist.");
                var X = analyseMaster(doc, mm.artboard, mm.focal || null, mm.roles || null, mm.follow);
                if (X.error) throw new Error(doc.artboards[mm.artboard].name + ": " + X.error);
                Ms.push(X);
            }
            var sizes = [];
            for (i = 0; i < job.sizes.length; i++) {
                var z = job.sizes[i], plate = z.plate ? new File(z.plate) : null;
                if (plate && !plate.exists) throw new Error(z.label + ": photo not found: " + z.plate);
                sizes.push({ w: z.w, h: z.h, label: z.label, plate: plate, M: pickMaster(Ms, z.w, z.h, z.master) });
            }
            var before = doc.artboards.length, active = doc.artboards.getActiveArtboardIndex();
            try {
                res = makeAdapts(M, sizes);
                if (job.runs) try { res.record = recordRun(doc, mi, before, job, res); } catch (e) { res.record = null; }   // a failed record never fails the Make
            } finally {
                try { doc.artboards.setActiveArtboardIndex(active); } catch (e2) {}   // the next read must not pick up a new adapt as the master
            }
        } else {
            res = describe(M, job.checks);
            if (job.png) exportPng(doc, mi, job.png.replace("{i}", String(mi)), M.W);   // {i}: one preview file per master
        }
        res.ok = true;
    } catch (e) {
        res = { ok: false, error: e.message + (e.line ? " (script line " + e.line + ")" : "") };
    }
    writeText(job.out, toJSON(res));
}

if (typeof app !== "undefined" && typeof app.documents !== "undefined") {
    if (typeof ADAPT_JOB !== "undefined" && ADAPT_JOB) runJob(ADAPT_JOB);
    else alert("This script is the engine of Grunter. Open Grunter.app to use it.");
}
