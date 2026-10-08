# Energy report

Example note for trying Sankey Flow. Copy the `examples` folder into a vault.

## Supply table

Put the cursor in this table and run **Sankey Flow: Create diagram from current table**.

| Source | Target | Value |
|---|---|---:|
| [[Coal]] | Electricity | 50 |
| Gas | Electricity | 30 |
| Electricity | Homes | 60 |
| Electricity | Industry | 20 |

## Inline diagram

```sankey-flow
height: 260
prefix: $
Wages [1500] Budget
Other [250] Budget
Budget -> Taxes: 400
Budget -> [[Grid#Overview|Housing]]: 600
Budget -> Food: 300
Budget -> Savings: 450
```

## Embedded diagram note

![[Energy flow]]

## Code block reference with options

```sankey-flow
diagram: [[Energy flow]]
height: 300
title: false
```
