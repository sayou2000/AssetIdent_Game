# AssetIdent: The Handover Quest 🕹️  v2.0

Ein **80er-Retro-Arcade-Spiel** im Browser für AssetIdent. Es macht den realen
**Handover Gap** im Facility Management spielbar: der Spieler ist Tech Inspector,
erfasst Anlagen gegen einen laufenden Übergabetermin und verwandelt visuelle
Daten in strukturierte, CAFM-fähige FM-Daten.

- **Pure HTML5 Canvas + Vanilla JS + Web Audio API.** Kein Framework, kein Build-Schritt.
- **Keine externen Assets** — Pixelgrafik und Chiptune werden zur Laufzeit erzeugt.
- **~130 KB gesamt.** Lädt sofort, läuft offline, überall einbettbar.
- **Desktop + Mobile** (Touch-Steuerung wird automatisch erkannt).
- **Einbettbar** per `<iframe>` oder `<assetident-game>` Web Component in jedes CMS.

## Was v2.0 gegenüber v1 ändert

v1 war eine Demo ohne Fail-State: die vier "Herausforderungen" waren Warte-Gates
(Knopf halten, Dampf abwarten, 50:50 raten) und eine falsche Antwort kostete fast
nichts. v2.0 macht daraus ein Spiel:

| | v1 | v2.0 |
|---|---|---|
| Zeit | zählt hoch, ohne Folgen | **Countdown bis zur Übergabe**; alles kostet oder bringt Sekunden |
| Typenschild | 1,5 s Knopf halten | **Fokus-Minispiel**: driftender Abstands-Sweetspot, Laufen verwackelt |
| Beleuchtung | Lampe einmal aufsammeln | **Akku als Ressource** (~31 s je Ladung) + Batterie-Pickups |
| Zugänglichkeit | höher springen | **echte Sichtlinien-Prüfung** gegen Steigleitungen (Raycast) |
| Dampf | abwarten | Timing-Fenster **+ Kontaktschaden** (−4 s) |
| Mängel | – | **Fadenkreuz-Minispiel** auf der Korrosionsstelle |
| Wissen | 1× Anlage/Bauteil, 50:50 | **5 Aufgabentypen**: DIN 276, Zähler, Prüffrist, VDI/VDMA-Intervall, Kältemittel/GWP |
| Fehler | Anlage wird trotzdem erfasst | **BAD DATA**: Datensatz wird falsch exportiert, im Report namentlich gelistet |
| Umfang | 1 Ebene, 6 Anlagen | **3 Ebenen, 17 Anlagen + Boss** ("Der Übergabetermin", 8 Datensätze) |
| Einstieg | Titelbild | **Manueller Prolog**: Seriennummer abtippen, Zeit wird gemessen |
| Abschluss | Score + gesparte Stunden | **Kategorie-Noten, Rang D–S, Fehlliste, personalisierte Hochrechnung** |

---

## 1. Project structure

```
AssetIdent_Game/
├── index.html          # Game shell: canvas, HUD, overlays, touch controls
├── style.css           # 80s CRT styling (scanlines, palette, retro UI)
├── bundle.js           # Full game: engine + audio synth + procedural art + mechanics
├── embed.html          # Live demo of iframe + Web Component embed methods
├── og-image.png        # 1200x630 Vorschaukarte fürs Teilen (LinkedIn/Slack)
├── security-headers.conf # Header-Snippet, in jede nginx-location eingebunden
├── Dockerfile          # nginx:alpine static host (~10 MB image)
├── docker-compose.yml  # One-command deploy
├── nginx.conf          # Hardened static server config (CSP-ready, gzip, caching)
├── .dockerignore
└── README.md
```

There is no `assets/` folder on purpose — sprites, SFX and music are synthesized
at runtime, which is what keeps the bundle under 200 KB and removes all external
dependencies (no broken images, no CDN risk, no licensing).

---

## 2. Run locally (no install)

You only need a static file server (opening `index.html` via `file://` works for
basic testing, but a local server avoids any browser sandbox quirks with audio).

```bash
# Python (built-in on most systems)
python -m http.server 8080

# OR Node
npx serve .

# OR with Docker (see §4)
docker compose up -d --build
```

Open <http://localhost:8080>. On first interaction (click / key press) the audio
context unlocks and the synthwave music starts.

---

## 3. Spielablauf

| Aktion | Desktop | Mobile |
|---|---|---|
| Laufen | `A`/`D` oder `←`/`→` | ◀ ▶ |
| Springen | `W` / `↑` | ▲ |
| Von Plattform fallen | `S` / `↓` | – |
| **Scannen** | `SPACE` (bei Typenschildern halten) | SCAN |
| Lampe an/aus | `F` / `Shift` | 💡 |
| Antworten | `1` `2` `3` `4` | Antwort antippen |
| Pause | `P` / `Esc` | – |
| Stumm | `M` | – |

### Ablauf

**Prolog → 3 Ebenen → Boss → Report.** Gesamtspielzeit ca. 6–8 Minuten.

1. **Prolog "Manuelle Erfassung"** — kein Scanner. Der Spieler tippt eine
   Seriennummer per Hand ab; Zeit und Tippfehler werden gemessen. Aus dieser
   *eigenen* Messung wird am Ende die Hochrechnung gebaut. Überspringbar.
2. **01 BAUPHASE** (105 s, 5 Anlagen) — führt Scan, Fokus und Zählerablesung ein.
3. **02 TECHNIKZENTRALE** (120 s, 6 Anlagen) — Dunkelzonen mit Akku, Steigleitung
   vor dem Typenschild, Dampfventil, Mängelerkennung.
4. **03 ÜBERGABETAG** (115 s, 6 Anlagen) — alles gemischt, plus ein echtes Loch im Boden.
5. **Boss "DER ÜBERGABETERMIN"** — 8 Datensätze im CAFM-Export, die Zeit pro
   Datensatz sinkt von 5,4 s auf 2,6 s. Jeder Fehler geht als BAD DATA raus.

### Die zwei Stufen jeder Anlage

Jede Anlage hat eine **Zugangs-Herausforderung** (Geschicklichkeit) und optional
eine **Wissens-Aufgabe** (Fachwissen) — genau die Produktlogik: erst erfassen,
dann strukturieren.

**Zugang** (Badge über der Anlage):

| Badge | Mechanik |
|---|---|
| `SCAN` | frei zugänglich, ein Tastendruck |
| `TYP` | Typenschild unscharf → **Fokus-Minispiel**: im driftenden Boden-Marker stehen bleiben, `SPACE` halten. Laufen verwackelt (halbe Füllrate). Ohne einen einzigen Abbruch = *PERFECT SCAN* (+3 s) |
| `ROHR` | Steigleitung verdeckt die Sichtlinie → über die Plattformen auf die andere Seite |
| `DAMPF` | zwischen zwei Dampfstößen scannen; Kontakt verbrennt (−4 s) |
| `MANGEL` | sweependes Fadenkreuz auf der Korrosionsstelle stoppen; daneben = −2 s |
| *(dunkel)* | Anlage in einer Dunkelzone → Lampe `F`. Akku: ~31 s je Ladung, +50 % je Batterie |

**Wissen** (zweites Badge):

| Badge | Aufgabe |
|---|---|
| `DIN276` | Kostengruppe zuordnen (410/420/430/440/480) |
| `ZÄHLER` | Zählerstand korrekt übernehmen — die Falschantworten sind Zahlendreher |
| `FRIST` | Prüfplakette gegen das Ist-Datum bewerten (gültig / abgelaufen) |
| `WARTUNG` | Intervall nach DIN EN 50172, VDI 6022, BetrSichV, TrinkwV |
| `ESG` | Kältemittel-GWP (R-32 / R-410A / R-404A) → t CO₂e für Scope 1 |

Nach jeder Antwort erscheint kurz die **Begründung mit Normbezug** — das ist die
inhaltliche Nutzlast des Spiels. Falsch = **BAD DATA**: der Datensatz geht
fehlerhaft raus, wird gezählt und im Report namentlich aufgeführt.

### Zeit ist die einzige Währung

| Ereignis | Zeit |
|---|---|
| Perfekter Fokus-Scan | **+3 s** |
| Falsche Antwort (BAD DATA) | −6 s |
| Dampf-Kontakt | −4 s |
| Sturz in ein Loch | −3 s |
| Fadenkreuz verfehlt | −2 s |
| Timer auf 0 | Übergabe wird erzwungen → Report |

### Score & Rang

- **SCORE** — 300 Basis je Anlage, +200 Fokus-Bonus, +250 richtige Aufgabe,
  +150 Mangel gefunden, ×Combo (bis ×2,0 bei 5 fehlerfreien Erfassungen in Serie),
  + Restzeit ×10 je Ebene.
- **HUD** — `EBENE` · `SCORE` · `DATEN` (erfasst/gesamt) · `QUALITÄT`
  (saubere/beantwortete Datensätze) · `ÜBERGABE IN` (Countdown).
- **HANDOVER-SCORE** = 45 × Vollständigkeit + 40 × Datenqualität + 15 × Tempo.
- **Rang** — S ab 92 Punkten **und null BAD DATA** ("AUDIT-SAFE"), A ab 84,
  B ab 70, C ab 55, sonst D.

### Report (zweiseitig)

**Seite 1 — Befund:** Rang, Kategorie-Noten (A+ bis F je Herausforderungstyp),
Liste der **nicht erfassten** Anlagen ("tauchen im CAFM nie auf") und der
**falsch strukturierten** Datensätze mit gegebener vs. richtiger Antwort.

**Seite 2 — Bilanz:** die personalisierte Hochrechnung auf 400 Anlagen mit
offengelegtem Rechenweg (gemessene Sekunden je Feld aus dem Prolog × 8 Felder je
CAFM-Datensatz vs. das im Spiel gemessene Scan-Tempo, beide Seiten ohne Laufweg),
Faktor, gesparte Stunden, erfasste t CO₂e, Bestenliste und der Marketing-CTA.

---

## 4. Deployment (Docker / Coolify / Nginx)

The game is a pure static site — any static host works. The included Docker setup
is a ~10 MB `nginx:alpine` image.

```bash
# Build & run
docker compose up -d --build
# → http://localhost:8080

# Or a one-shot docker run
docker build -t assetident/handover-quest:2.0.0 .
docker run -d -p 8080:8080 --name assetident-game --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true --memory=128m \
  assetident/handover-quest:2.0.0
```

### Vor dem ersten Deploy

Vier Dinge, die sonst still schiefgehen:

1. **CTA-URL setzen** (§6). Vorgabe ist die Beispiel-Domain — der einzige
   Marketing-Button des Spiels führt sonst ins Leere.
2. **`?v=` bei jedem Release mitziehen.** `bundle.js` und `style.css` tragen keinen
   Inhalts-Hash und werden ein Jahr lang `immutable` ausgeliefert; `index.html`
   referenziert sie mit `?v=2.0.0`. Wird die Version nicht erhöht, bekommen
   wiederkehrende Besucher die alte Fassung — der Deploy ist grün und ändert nichts.
3. **`read_only` braucht Schreibflächen.** nginx legt `/var/run/nginx.pid` an und
   nutzt die temp-Verzeichnisse unter `/var/cache/nginx`; beide sind in
   `docker-compose.yml` als tmpfs eingehängt. Fehlen sie, startet der Container gar
   nicht (`open() "/var/run/nginx.pid" failed (30: Read-only file system)`).
4. **`og:image` auf absolute URL umstellen**, sobald die Domain feststeht:
   `https://deine-domain.de/og-image.png`. Facebook und LinkedIn kommen meist mit
   dem relativen Pfad klar, X/Twitter nicht. Danach einmal durch den
   [LinkedIn Post Inspector](https://www.linkedin.com/post-inspector/) schicken,
   der cached Vorschaukarten aggressiv.

### Coolify
1. New Resource → **Docker Compose**, auf dieses Repository zeigen.
2. Exposed Port `8080`.
3. Domain eintragen; Coolify stellt TLS automatisch aus.
4. Deploy. Danach `https://<domain>/healthz` prüfen — muss `ok` liefern.

### Plain Nginx
Copy `index.html`, `style.css`, `bundle.js` into your web root and reuse
`nginx.conf` (it sets correct MIME types, security headers, gzip, and caching).
Embeds work out of the box — `frame-ancestors` is intentionally open; tighten the
CSP line in `nginx.conf` to your domains in production.

---

## 5. Embedding into external sites

The game is designed to be dropped into WordPress, Webflow, custom HTML, or any
CMS that allows iframes. See [`embed.html`](embed.html) for a live demo.

### Option A — Responsive iframe (recommended, universal)

```html
<iframe
  src="https://YOUR-GAME-HOST/index.html?utm_source=linkedin&utm_campaign=handover"
  title="AssetIdent: The Handover Quest"
  loading="lazy" allow="autoplay; fullscreen"
  style="width:100%;max-width:960px;height:480px;border:0;background:#000;"
  allowfullscreen></iframe>
```

The canvas auto-scales (16:9) to fill the iframe width. `loading="lazy"` keeps it
out of the critical path. Recommended iframe height: **480 px** (or any 16:9 ratio).

### Option B — Web Component (cleaner API + event relay)

```html
<script>
customElements.define('assetident-game', class extends HTMLElement {
  connectedCallback() {
    const src = this.getAttribute('src') || 'index.html';
    const p = ['source','medium','campaign','content','term']
      .filter(k => this.hasAttribute('utm-' + k))
      .map(k => 'utm_' + k + '=' + encodeURIComponent(this.getAttribute('utm-' + k)))
      .join('&');
    const f = document.createElement('iframe');
    f.src = src + (p ? '?' + p : '');
    f.style = 'width:100%;height:480px;border:0;';
    f.loading = 'lazy'; f.allow = 'autoplay;fullscreen';
    this.appendChild(f);
  }
});
</script>

<assetident-game
  src="https://YOUR-GAME-HOST/index.html"
  utm-source="linkedin"
  utm-campaign="handover">
</assetident-game>
```

### WordPress specific
Paste the iframe into a **Custom HTML block**. If your theme strips iframes,
install a "Raw HTML" / "Code Embed" plugin, or ask the host to add your game
domain to the `frame-ancestors` CSP / `ALLOW` list.

---

## 6. Tracking & marketing hooks

### URL parameters
The game reads standard `utm_*` query params and forwards them on every event:

```
https://YOUR-GAME-HOST/index.html?utm_source=linkedin&utm_medium=social&utm_campaign=handover&utm_content=q3-launch
```

### Events emitted
Each significant action fires an event three ways (best-effort, non-blocking):

1. **`navigator.sendBeacon`** / `fetch` POST to `window.ASSETIDENT_API` (set before the script loads — see below) or `?api=<url>`.
2. **`window.assetIdentEvents`** array inside the iframe (parent can read it via `contentWindow`).
3. Logged to the console when running in `?debug=1`.

| Event | Wann | Payload |
|---|---|---|
| `game_loaded` | Seitenaufruf | `touch`, `levels`, `assets`, `utm`, `ver` |
| `game_start` | START gedrückt | `prologue` (bool) |
| `prologue_done` | Seriennummer abgetippt | `seconds`, `typos` — **die Kennzahl für die Hochrechnung** |
| `level_start` | Ebene beginnt | `level`, `time` |
| `asset_captured` | Anlage erfasst | `id`, `label`, `level`, `challenge`, `task`, `points`, `good` |
| `task_answer` | jede Wissensantwort | `kind`, `boss`, `correct`, `chosen`, `label` |
| `pickup` | Batterie aufgenommen | `id`, `type` |
| `level_complete` | Ebene geschafft | `level`, `time_left`, `bonus`, `score` |
| `run_complete` | Lauf endet (geschafft **oder** Timeout) | `reason`, `rank`, `handover`, `score`, `captured`, `total`, `good`, `bad`, `elapsed_s`, `best_combo`, `co2e`, `saved_hours` |
| `highscore` | Initialen gespeichert | `entry`, `board` |
| `contact_click` | Klick auf den LinkedIn-Credit | `from` (Spielzustand, aus dem geklickt wurde) |

Für die Kampagnen-Auswertung sind vor allem interessant: `prologue_done.seconds`
(wie lange Besucher wirklich für ein Feld brauchen), `task_answer.correct` je
`kind` (wo das Fachwissen im Markt fehlt — direkt verwertbares Content-Signal)
und `run_complete.rank` als Funnel-Stufe.

### Wiring an API endpoint
Set the endpoint globally before `bundle.js` loads (e.g. in `index.html`):

```html
<script>window.ASSETIDENT_API = "https://api.yourdomain.com/v1/game/events";</script>
<script src="bundle.js"></script>
```

…or pass it per-link: `?api=https://api.yourdomain.com/v1/game/events`. The
request is sent with `mode: "no-cors"`, so it works against any analytics
collector / pixel endpoint without CORS configuration (your server just reads
the raw body). For richer server-side handling, drop `mode: "no-cors"` in `bundle.js`.

### CTA-Landing-URL setzen — PFLICHT VOR DEM LIVEGANG

Der CTA „ASSETIDENT LIVE ANSEHEN" auf Report-Seite 2 zeigt auf
`window.ASSETIDENT_LANDING`. Vorgabe ist die **Beispiel-Domain**
`https://assetident.example.com` und damit ein toter Link. Angehängt werden
`utm_source`, `utm_campaign` und `ai_rank=<Rang>`, sodass die Attribution bis zur
Anmeldung durchläuft — inklusive der Information, wie gut der Besucher gespielt hat.

Die Variable steht im obersten `<script>`-Block von `index.html`:

```html
<script>window.ASSETIDENT_LANDING = "https://deine-landingpage.de";</script>
```

Warum dort und nicht als Umgebungsvariable: Der Container liefert ausschließlich
statische Dateien aus, niemand ersetzt zur Laufzeit etwas im HTML. Eine
`ASSETIDENT_LANDING`-Variable im Compose — so stand es hier früher — ist wirkungslos.

---

## 7. Architecture & customization

`bundle.js` is one IIFE organized into clearly commented sections (see the header
block). Key extension points:

| Ziel | Stelle in `bundle.js` |
|---|---|
| Farben / Skin ändern | `PAL` |
| Spielgefühl (Physik) | `CFG.GRAVITY`, `MOVE_SPEED`, `JUMP_V`, `COYOTE`, `JUMP_BUFFER` |
| Zeitbudget je Ebene | `LEVELS[i].time` |
| Zeit-Strafen/-Boni | `CFG.PENALTY_*`, `CFG.BONUS_PERFECT` |
| Fokus-Minispiel schwerer/leichter | `CFG.FOCUS_TOL`, `FOCUS_FILL`, `FOCUS_DRAIN`, `sweetDistance()` |
| Akku-Haushalt | `CFG.BATTERY_DRAIN`, `BATTERY_PICKUP`, `LIGHT_RANGE` |
| Fragen ändern / ergänzen | `Q`, `Q_METER`, `Q_STICKER` — jede Frage hat ein `why` mit Normbezug |
| Ebene/Anlagen ändern | `LEVELS` (`plats`, `blockers`, `darkzones`, `vents`, `pickups`, `assets`) |
| Neues Anlagen-Bild | `drawAssetByType()` |
| Neue Zugangs-Mechanik | `targetStatus()` + eigenes `update…()` + `BADGE` |
| Neue Wissens-Aufgabe | `CFG.TASK_TIME`, `renderTaskPanel()`, `CAT_LABELS` |
| Boss-Runde | `CFG.BOSS_*`, `BOSS_QS`, `BOSS_LABELS` |
| Rang-Schwellen | `buildReport()` |
| Hochrechnung | `CFG.BUILDING_ASSETS`, `CFG.FIELDS_PER_RECORD` |
| Musik | `Audio`'s `BASS` / `ARP` MIDI-Arrays |
| Neue SFX | `Audio.SFX` |

### Kulisse (Section 16a `SCENERY`)

Der Hintergrund ist kein Farbverlauf, sondern eine fünflagige Parallax-Kulisse aus
TGA- und Gebäudeelementen — alles procedural, ohne Bilddateien:

| Lage | Parallax | Inhalt |
|---|---|---|
| Rohbauhülle | 0.16 | Betonwand mit Schalungsfugen, Ankerlöchern, Betonierfugen, Mauerwerksflecken |
| Installation | 0.42 | Kabelrinnen mit Kabelbündel, gedämmte Rohrleitungen mit Aufhängungen und Medien-Kennfarben, Lüftungskanäle mit Flanschen, Verteiler, Pumpengruppen, E-Rohre |
| Technikzentrale | 0.70 | große Silhouetten: RLT-Geräte, Schaltschrankreihen, Pufferspeicher, Treppenlauf, Sprinklerleitung |
| Decke | 0.62 | Rohdecke, Unterzüge, Leuchtstoffbalken mit Lichtkegeln (einige mit defektem Vorschaltgerät → flackern) |
| Wandausstattung | 0.88 | Fluchtwegschilder, Wandhydranten, Feuerlöscher, Stahltüren, Hinweisschilder, Heizkörper |
| Boden | 1.0 | Sicherheitsmarkierung (gelb gestrichelt), Bodenabläufe, Estrichtextur |

Zwei Regeln, an denen die erste Fassung gescheitert ist:

- **Deterministisch platzieren.** Die Verteilung kommt aus `hash01(index)`, nie aus
  `Math.random()` — sonst springt die Kulisse jeden Frame neu.
- **Hintergrund muss Hintergrund bleiben.** Am Ende von `drawBackground()` liegt ein
  globaler Scrim (`rgba(8,14,26,0.28)`). Ohne ihn wurden bodennahe Requisiten
  (Schrankreihen, ein roter Ausdehnungsbehälter) als scanbare Anlagen missverstanden.
  Aus dem gleichen Grund hängen Feuerlöscher an der Wand statt auf dem Laufweg und
  die Badges der Anlagen haben eine dunkle Unterlegplatte.

Themen je Ebene über `LEVELS[i].theme`: `site` (Rohbau, Tageslicht durch
Wandöffnungen mit Außengerüst, Kabeltrommeln, Paletten), `plant` (dichte
Installation, kühl, Notbeleuchtung), `handover` (in Betrieb, wärmer, plus
Aktenordner-Stapel — das Papier, das das Produkt ersetzen soll).

### Schrift: Bitmap-Font im Canvas, Monospace im DOM

Die Beschriftungen im Spielfeld waren zunächst mit `ctx.fillText` in 8px Courier
gezeichnet. Das war der Fehler: der Browser glättet kleine Schrift zu grauen
Halbpixeln, und `image-rendering: pixelated` vergrößert diese Unschärfe dann auf
das Doppelte. Ergebnis war Matsch — genau bei der Statuszeile, die das ganze
Feedback-System trägt.

Jetzt zeichnet `pxText()` einen **handgesetzten 5×7-Bitmap-Font** Pixel für Pixel
(`GLYPHS` in Section 16). Kein Antialiasing, also scharf bei jedem Skalierungsfaktor
— und das ist ohnehin die Technik, die die Vorbilder benutzt haben.

- Nur Großbuchstaben. Deutsches `ß` wird von `toUpperCase()` automatisch zu `SS`,
  Umlaute werden als Basisglyphe + zwei Punkte darüber gezeichnet (`UML`).
- `pxText(text, x, baselineY, color, {center, outline, plain})`. `outline` zeichnet
  eine 4-fache schwarze Kontur — nötig für Floater und Anzeigen, die über beliebiger
  Kulisse liegen.
- Horizontale Pixelläufe werden zu einem `fillRect` zusammengefasst, damit die
  Zeichenlast niedrig bleibt.
- Breite messen mit `pxWidth(t)` (= `len*6-1`), nicht mit `measureText`.

Die **DOM-Panels** sind der umgekehrte Fall: dort ist Lesbarkeit wichtiger als
Pixel-Look, weil dort die Fachinhalte stehen. Deshalb `Consolas / DejaVu Sans Mono /
Menlo` statt Courier New, `-webkit-font-smoothing: antialiased` statt `none`,
hellere Sekundärfarbe (`--at-dim`) und durchgehend eine Stufe größere Schriftgrade.
Der Retro-Charakter kommt vom Canvas, nicht von unleserlichen Panels.

Langer Report: `.at-panel--report` ist eine Flex-Spalte aus scrollendem
`.at-rep-body` und fixierter `.at-rep-foot`. Ohne das rutschen „weiter" und der
CTA bei kleinen Fenstern unter den Falz — was zweimal passiert ist, einmal durch
zu viel Inhalt und einmal durch die größere Schrift.

### Level-Geometrie: zwei harte Regeln

Wer `LEVELS` anfasst, muss zwei Dinge einhalten — beide sind beim Bau von v2.0
schiefgegangen und wurden per Rechnung gefunden, nicht per Auge:

1. **Sprunghöhe.** Maximale Sprunghöhe ist `JUMP_V²/(2·GRAVITY)` = **80 px**.
   Das seitliche Fenster oberhalb einer Zielhöhe `h` ist nur
   `2·√(v²−2·g·h)/g · MOVE_SPEED` — bei 44 px Steighöhe rund **55 px**.
   Übereinanderliegende Plattformen sollten sich daher horizontal **überlappen**
   (~30 px), nicht 50 px auseinanderliegen.
2. **Sichtlinien-Rätsel.** Eine `obstructed`-Anlage muss von der verdeckten Seite
   *innerhalb* `CFG.SCAN_RANGE` (62 px) liegen — sonst sieht der Spieler die
   Meldung "keine Sichtlinie" nie und das Rätsel existiert nicht. Deshalb sind die
   Steigleitungen `solid: true`, 96 px hoch (also nicht überspringbar) und die
   Anlage steht direkt dahinter auf dem Boden.

### Debug-Modus

`?debug=1` loggt alle Events in die Konsole und legt Testhandles offen:
`window.AssetIdent._dev = { Game, CFG, LEVELS, beginLevel, startPrologue, endRun }`.
Damit lässt sich jede Szene direkt anspringen (z. B. für Screenshots) oder eine
Ebene ohne Vorlauf starten.

The internal render resolution is **480×270** and CSS upscales it with
`image-rendering: pixelated`, which is what produces the authentic crunchy 8-bit
look on any display. The CRT scanline + vignette overlay is a pure-CSS layer
(`#at-crt-overlay`).

---

## 8. Bundle size & performance

| File | Size |
|---|---|
| `index.html` | ~3 KB |
| `style.css` | ~15 KB |
| `bundle.js` | ~114 KB |
| **Gesamt** | **~132 KB** unkomprimiert, ~30 KB gzip |

- No external requests at runtime (no fonts, no images, no CDNs).
- Fixed-timestep game loop (60 Hz) with interpolation-free deterministic updates.
- `requestAnimationFrame` driven; pauses work when the tab is hidden.
- Container memory limit 128 MB is generous — actual usage is a few MB.

---

## 9. Browser support

Works on all evergreen browsers (Chrome, Edge, Firefox, Safari 14+) and iOS/Android
mobile browsers. Requires `AudioContext` (universal since 2020) and `canvas` (universal).

---

## 10. License & credits

MIT License — freie Verwendung für die AssetIdent-Kampagne.

Konzept: der **Handover Gap** im Facility Management als Arcade-Spiel — unlesbare
Typenschilder, fehlendes Licht, verbaute Anlagen, Dampf, Instandhaltungsstau und
die Frage, ob am Übergabetag wirklich jeder Datensatz sauber im CAFM landet.

Fachliche Bezüge in den Aufgaben: DIN 276 (Kostengruppen 410–480),
DIN EN 50172 (Sicherheitsbeleuchtung), VDI 6022 (RLT-Hygieneinspektion),
BetrSichV (Prüffristen, Aufzug), TrinkwV (Legionellen), DIN 14406-4 (Feuerlöscher),
GWP-Werte nach AR4 (R-32 675, R-410A 2088, R-404A 3922).
