import { browserCatalog } from "../src/business/browser-catalog.js";
import { browserCatalogDescriptions } from "../src/business/browser-catalog-descriptions.js";

const entry = browserCatalog.entry("紫微");
const description = "百分比生命值\n白值生命值";
if (!entry || entry.name !== "紫微" || entry.description !== description || browserCatalogDescriptions[entry.name] !== description) {
  throw new Error("canonical Ziwei catalog entry must resolve its existing description");
}
if (Object.hasOwn(browserCatalogDescriptions, "紫薇")) throw new Error("description correction must not retain a misspelled alias key");
console.log("browser catalog description consistency passed");
