/** Synthetic mapping target derived from Python SessionState.snapshot semantics; not an importer. */
export const pythonSessionGoldenFixture = {
  bag_current_count: 2, bag_capacity: 40,
  rows: [
    { id: "golden-main", kind: "主星", name: "天府", level: 40, quality: "橙" },
    { id: "golden-support", kind: "辅星", name: "解神", level: 20, quality: "紫" },
  ],
  plan_targets: { "golden-main": 60 },
  experience_quantities: { "橙星曜": 3, "紫星曜": 4, "白星曜": 5 },
  image_pools: { "golden-image": "main" },
  confirmed_image_pools: ["golden-image"],
  overlap_pairs: { main: [["golden-image", "golden-image-2"]], support: [] },
  overlap_audit: [{ status: "synthetic" }], image_audit: { "golden-image": { status: "synthetic" } }, postprocess_revision: 7,
} as const;
