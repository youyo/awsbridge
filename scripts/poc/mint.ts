import { parseArgs } from "node:util";
import { mintToken } from "./token";

const { values } = parseArgs({
  options: {
    aud: { type: "string" },
    "exp-offset": { type: "string" },
    "other-key": { type: "boolean", default: false },
  },
});
const offset = values["exp-offset"];
console.log(
  await mintToken({
    aud: values.aud,
    expOffset: offset === undefined ? undefined : Number(offset),
    otherKey: values["other-key"],
  }),
);
