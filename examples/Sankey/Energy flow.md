---
sankey-flow: diagram
sankey-links:
  - "[[Coal]]"
  - "[[Grid#Overview]]"
---

```sankey-flow
{
  "type": "sankey-flow",
  "version": 1,
  "meta": {
    "title": "Energy flow",
    "description": "Example diagram shipped with Sankey Flow.",
    "created": "2026-10-08T00:00:00.000Z",
    "modified": "2026-10-08T00:00:00.000Z"
  },
  "nodes": [
    {"id":"coal","label":"Coal","link":"[[Coal]]"},
    {"id":"gas","label":"Natural gas"},
    {"id":"nuclear","label":"Nuclear"},
    {"id":"wind","label":"Wind","group":"renewable"},
    {"id":"electricity","label":"Electricity","description":"All generated electricity.","link":"[[Grid#Overview]]"},
    {"id":"homes","label":"Homes"},
    {"id":"industry","label":"Industry"},
    {"id":"losses","label":"Losses"}
  ],
  "flows": [
    {"id":"f1","source":"coal","target":"electricity","value":50},
    {"id":"f2","source":"gas","target":"electricity","value":30},
    {"id":"f3","source":"nuclear","target":"electricity","value":22},
    {"id":"f4","source":"wind","target":"electricity","value":14},
    {"id":"f5","source":"electricity","target":"homes","value":45},
    {"id":"f6","source":"electricity","target":"industry","value":44,"label":"Manufacturing and processing"},
    {"id":"f7","source":"electricity","target":"losses","value":27}
  ],
  "display": {
    "valueSuffix": " TWh"
  },
  "layout": {
    "align": "justify",
    "iterations": 6
  },
  "extensions": {}
}
```

Notes written below the diagram are preserved when it is edited.
