# Road-closure assessment

Policy ID: `wrl2017-small-passenger-v1`. Implemented in
[`lib/flood-assessment.js`](../lib/flood-assessment.js).

The assessment applies the small-passenger-vehicle envelope discussed in
[Smith, Modra, Tucker & Cox (2017), WRL TR 2017/07, Table 7-2 p48 and Figure 7-3 p45](https://www.unsw.edu.au/content/dam/pdfs/engineering/civil-environmental/water-research-laboratory/publications/WRL-TR2017-07-Vehicle-Stability-Testing-for-Flood-Flows.pdf).
MercuriL closes when **any** limit is reached:

| Check | Closure threshold |
|---|---|
| Water depth above the road | ≥ 0.30 m |
| Water speed | ≥ 3.0 m/s |
| Depth × speed | ≥ 0.30 m²/s |

These are intersecting limits, not a depth-only test. Closing at equality is
MercuriL's conservative operating choice; the paper writes the stability product
with `≤`. The table also gives 0.15 m at 3 m/s, inconsistent with its 0.30 product
limit. Figure 7-3 shows the product curve reaching 0.10 m at 3 m/s. We retain the
stricter intersection and do not interpolate a looser curve through 0.15 m.

The paper concerns vehicle stability and recommends conservative interpretation
of laboratory results. It does not verify an actual road's integrity or establish
that a below-threshold crossing is trafficable. It supplies no universal conversion
from radar surface velocity to representative flow velocity. Deployment must
establish a road-level depth datum and credible, calibrated velocity measurements.

## Decisions and recovery

- **Closure triggered:** a WRL-based limit is reached, or the device reports a
  warning/closure. The reason distinguishes the scientific limit from device state.
- **No closure trigger in this sample:** all three checks are present and below
  their limits. This is not an OPEN report or permission to enter floodwater.
- **Assessment incomplete:** a channel is missing/invalid or the device is blind.
  A known independent limit can still close despite another missing channel.
- **Keep road closed:** an existing closure persists until a fresh, newer positive OPEN
  (`dry` in the legacy contract) has complete measurements below every limit.
  Stale, unclassed, blind and partial reports never authorize reopening.

Velocity uses magnitude for legitimate signed measurements. Satellite missing
sentinels are decoded to NULL before assessment. Negative/nonfinite depth and
invalid product values are unavailable. The product check uses the larger of
the reported product and the product of a complete measurement pair, so an
understated supplied product cannot suppress closure. UNCAL/NO_TARGET samples
have no usable depth, velocity or product, even if firmware fills them with zeros.

## Presentation and evidence

The road decision and its reason lead the map popup and telemetry console;
measurements sit under “Measurements and WRL limits”. Each sample assessment
contains policy ID, source location, checks, result and reasons. A closure episode
stores its triggering assessment separately from later samples. Historical series
retain the raw device class and expose a separate evaluation using the current
policy. Bench and simulated results retain their labels and do not become real
installed-road evidence.
