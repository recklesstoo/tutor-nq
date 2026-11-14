#!/usr/bin/env python3
"""Descarga velas de 1 minuto de Yahoo Finance y las acumula en data/<SÍMBOLO>/<fecha>.csv.

Yahoo solo entrega unos 7 días de velas de 1 minuto por consulta, así que cada corrida
trae la última semana y la mezcla con lo ya guardado. Con el tiempo el historial crece.

Cada archivo es de un día calendario en hora de Nueva York, con líneas:
    segundos_unix_utc,apertura,máximo,mínimo,cierre,volumen
data/index.json lista los archivos y las fechas que tienen sesión regular (09:30-16:00).
"""
import json
import os
import sys
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

SYMBOLS = {"NQ": "NQ=F", "MNQ": "MNQ=F"}          # nombre en el sitio -> símbolo en Yahoo
NY = ZoneInfo("America/New_York")
DATA = os.environ.get("DATA_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
MIN_RTH_BARS = 60                                  # velas entre 09:30 y 16:00 para contar como sesión


def fetch(yahoo_symbol):
    """Devuelve filas (epoch, o, h, l, c, v) de la última semana en velas de 1 minuto."""
    import yfinance as yf

    last_error = None
    for period in ("7d", "5d"):
        try:
            df = yf.Ticker(yahoo_symbol).history(interval="1m", period=period, auto_adjust=False, prepost=True)
            if df is not None and len(df):
                return to_rows(df)
        except Exception as exc:  # Yahoo cambia sus respuestas cada cierto tiempo
            last_error = exc
        time.sleep(3)
    if last_error:
        raise last_error
    return []


def to_rows(df):
    now = time.time()
    rows = []
    for ts, r in df.iterrows():
        o, h, l, c = r.get("Open"), r.get("High"), r.get("Low"), r.get("Close")
        if any(x is None or x != x for x in (o, h, l, c)):      # x != x detecta NaN
            continue
        epoch = int(ts.timestamp())
        if epoch + 60 > now:                                    # la vela del minuto en curso está incompleta
            continue
        v = r.get("Volume")
        rows.append((epoch, float(o), float(h), float(l), float(c), int(v) if v == v and v is not None else 0))
    return rows


def fmt(x):
    return ("%.2f" % x).rstrip("0").rstrip(".")


def read_day(path):
    day = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                parts = line.strip().split(",")
                if len(parts) >= 5 and parts[0].isdigit():
                    day[int(parts[0])] = line.strip()
    return day


def merge(name, rows):
    """Mezcla las filas nuevas con los archivos existentes. Devuelve cuántas líneas cambiaron."""
    folder = os.path.join(DATA, name)
    os.makedirs(folder, exist_ok=True)
    by_day = {}
    for row in rows:
        date = datetime.fromtimestamp(row[0], NY).strftime("%Y-%m-%d")
        by_day.setdefault(date, []).append(row)
    changed = 0
    for date, day_rows in by_day.items():
        path = os.path.join(folder, date + ".csv")
        day = read_day(path)
        before = dict(day)
        for epoch, o, h, l, c, v in day_rows:
            day[epoch] = "%d,%s,%s,%s,%s,%d" % (epoch, fmt(o), fmt(h), fmt(l), fmt(c), v)
        if day != before:
            changed += sum(1 for k in day if before.get(k) != day[k])
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write("\n".join(day[k] for k in sorted(day)) + "\n")
    return changed


def rebuild_index():
    index = {"updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": "Yahoo Finance", "symbols": {}}
    for name in SYMBOLS:
        folder = os.path.join(DATA, name)
        files, sessions = [], []
        if os.path.isdir(folder):
            for fn in sorted(os.listdir(folder)):
                if not fn.endswith(".csv"):
                    continue
                date = fn[:-4]
                files.append(date)
                rth = 0
                for epoch in read_day(os.path.join(folder, fn)):
                    t = datetime.fromtimestamp(epoch, NY)
                    if 570 <= t.hour * 60 + t.minute < 960:
                        rth += 1
                if rth >= MIN_RTH_BARS:
                    sessions.append(date)
        index["symbols"][name] = {"files": files, "sessions": sessions}
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, indent=1)
    return index


def main():
    failures = 0
    for name, yahoo_symbol in SYMBOLS.items():
        try:
            rows = fetch(yahoo_symbol)
            print("%s (%s): %d velas recibidas, %d líneas nuevas o cambiadas" % (name, yahoo_symbol, len(rows), merge(name, rows)))
            if not rows:
                failures += 1
        except Exception as exc:
            failures += 1
            print("%s (%s): no se pudo descargar: %r" % (name, yahoo_symbol, exc), file=sys.stderr)
    index = rebuild_index()
    for name, info in index["symbols"].items():
        print("%s: %d archivos, %d sesiones" % (name, len(info["files"]), len(info["sessions"])))
    if failures == len(SYMBOLS):
        sys.exit(1)       # si falla todo, la corrida queda en rojo para que te avise GitHub


if __name__ == "__main__":
    main()
