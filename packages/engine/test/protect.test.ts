import { describe, expect, test } from "bun:test";
import { rawSensorToReadings, rawSensorToSensor, readingsFromDeviceEventItem, type RawSensor } from "../src/protect";

// Fixture matches the real shape returned by a live console's GET
// /v1/sensors (captured during API discovery — see API_NOTES.md), not a
// guess at the schema. Covers the bug this file's tests were added
// for: discoverSensors() must seed SensorStatus from this full snapshot
// immediately, not only from later websocket deltas — a battery sensor
// can go a long time between spontaneous reports, so without this a
// freshly discovered/reconnected sensor showed "no data yet" even though
// the console had already told us its current values.
const liveSensorFixture: RawSensor = {
  id: "6a78fa0701ef3003e4004277",
  name: "USL - Waterheater",
  stats: {
    light: { value: 4 },
    humidity: { value: 57 },
    temperature: { value: 17.82 },
  },
  lightSettings: { isEnabled: true },
  humiditySettings: { isEnabled: true },
  temperatureSettings: { isEnabled: true },
  leakSettings: { isInternalEnabled: true, isExternalEnabled: false },
  leakDetectedAt: null,
  externalLeakDetectedAt: null,
};

describe("rawSensorToSensor", () => {
  test("extracts name and only the metrics actually enabled on the device", () => {
    const sensor = rawSensorToSensor(liveSensorFixture);
    expect(sensor.id).toBe("6a78fa0701ef3003e4004277");
    expect(sensor.name).toBe("USL - Waterheater");
    expect(sensor.metrics.sort()).toEqual(["humidity", "leak", "lux", "temperature"].sort());
  });

  test("falls back to the device id when name is null", () => {
    const sensor = rawSensorToSensor({ ...liveSensorFixture, name: null });
    expect(sensor.name).toBe(liveSensorFixture.id);
  });
});

describe("rawSensorToReadings", () => {
  test("a full discovery snapshot yields a reading for every present metric", () => {
    const readings = rawSensorToReadings(liveSensorFixture.id, liveSensorFixture, 1_000);
    const byMetric = Object.fromEntries(readings.map((r) => [r.metric, r.value]));

    expect(byMetric.lux).toBe(4);
    expect(byMetric.humidity).toBe(57);
    expect(byMetric.temperature).toBe(17.82);
    expect(byMetric.leak).toBe(0); // both leakDetectedAt/externalLeakDetectedAt null -> dry
    expect(readings).toHaveLength(4);
    expect(readings.every((r) => r.sensorId === liveSensorFixture.id && r.timestamp === 1_000)).toBe(true);
  });

  test("leak reads as 1 when either leak timestamp is set", () => {
    const readings = rawSensorToReadings(
      "s1",
      { ...liveSensorFixture, leakDetectedAt: 12345, externalLeakDetectedAt: null },
      1_000
    );
    expect(readings.find((r) => r.metric === "leak")?.value).toBe(1);
  });

  test("a partial websocket delta only yields readings for fields actually present", () => {
    // Real observed shape: a delta carrying only wireless signal info,
    // no stats/leak fields at all — see API_NOTES.md's subscribe/devices
    // notes. Must NOT synthesize readings for metrics that didn't change.
    const readings = rawSensorToReadings("s1", { id: "s1" } as any, 1_000);
    expect(readings).toHaveLength(0);
  });
});

describe("readingsFromDeviceEventItem", () => {
  test("a single-id item yields readings attributed to that one sensor", () => {
    const readings = readingsFromDeviceEventItem(
      { id: "sensor-a", modelKey: "sensor", stats: { temperature: { value: 21.5 } } },
      1_000
    );
    expect(readings).toEqual([{ sensorId: "sensor-a", metric: "temperature", value: 21.5, timestamp: 1_000 }]);
  });

  // The bug this test guards against: per the live OpenAPI spec's
  // deviceBulkPartialWithReference schema, Protect can coalesce multiple
  // devices that changed the same field(s) at once into one message with
  // item.id as an *array*. Treating that array as a single sensor id (the
  // original bug) means the reading is attributed to no real sensor —
  // silently dropped, looking exactly like "the sensor stopped reporting."
  test("a bulk item with an array of ids fans the same delta out to every sensor in it", () => {
    const readings = readingsFromDeviceEventItem(
      { id: ["sensor-a", "sensor-b", "sensor-c"], modelKey: "sensor", stats: { humidity: { value: 44 } } },
      2_000
    );
    expect(readings).toEqual([
      { sensorId: "sensor-a", metric: "humidity", value: 44, timestamp: 2_000 },
      { sensorId: "sensor-b", metric: "humidity", value: 44, timestamp: 2_000 },
      { sensorId: "sensor-c", metric: "humidity", value: 44, timestamp: 2_000 },
    ]);
  });
});
