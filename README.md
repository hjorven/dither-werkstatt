# Dither-Werkstatt

1-Bit- und ASCII-Editor im Browser. Bilder werden live in Braille, Blockzeichen oder ASCII umgerechnet und lassen sich danach von Hand weiterzeichnen.

**Live:** https://hjorven.github.io/dither-werkstatt/

## Funktionen

- **7 Zeichensätze:** Braille (2 × 4 Punkte pro Zeichen), Viertelblöcke, Halbblöcke, 1-Bit-Block, Schattierung, ASCII klassisch, ASCII fein
- **8 Verfahren:** Atkinson, Floyd-Steinberg, Bayer 8 × 8 und 4 × 4, Punktraster, Linienraster, Rauschen, Schwelle
- **Regler:** Breite in Zeichen, Helligkeit, Kontrast, Gamma, Invertieren
- **Werkzeuge:** Stift, Radierer, Linie, Rechteck, Füllen, Text, Pipette, Verschieben
- **Zwei Pinsel:** *Punkt* setzt einzelne Rasterpunkte (z. B. einen Braille-Punkt), *Zeichen* setzt ganze Zeichen
- **Export:** Text kopieren, `.txt`, `.png` (1 ×, 2 ×, 4 ×), `.svg`
- Zurück und Vor, automatisches Speichern im Browser, Bild per Ziehen und Ablegen oder Einfügen
- Läuft komplett lokal, kein Bild verlässt das Gerät

## Tastenkürzel

| Taste | Funktion |
|---|---|
| `B` `E` `L` `R` `F` `T` `I` `H` | Stift, Radierer, Linie, Rechteck, Füllen, Text, Pipette, Verschieben |
| `P` | Pinsel zwischen Punkt und Zeichen umschalten |
| `+` `-` `0` | Vergrößern, Verkleinern, Einpassen |
| `Strg+Z` / `Strg+Umschalt+Z` | Zurück / Vor |

## Lokal starten

```bash
git clone https://github.com/hjorven/dither-werkstatt.git && cd dither-werkstatt && python3 -m http.server 8000
```

Danach http://localhost:8000 öffnen. Kein Build-Schritt, reines HTML, CSS und JavaScript.
