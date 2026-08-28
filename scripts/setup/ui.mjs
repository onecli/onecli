// The one module that imports @clack/prompts. Two jobs: give the wizard a
// single prompt vocabulary, and make Ctrl-C at ANY prompt exit 130 with a
// clean terminal — the guard below is that chokepoint.
//
// In --yes mode the ask* helpers return their defaults without prompting, so
// the flow code never branches on interactivity.

import * as p from "@clack/prompts";

let assumeYes = false;
export const setAssumeYes = (v) => {
  assumeYes = v;
};

const guard = (value) => {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(130);
  }
  return value;
};

export const outro = p.outro;
export const note = p.note;
export const log = p.log;
export const spinner = p.spinner;

/** @param {{message:string, options:Array<{value:string,label:string,hint?:string}>, initialValue:string}} opts */
export const askSelect = async (opts) =>
  assumeYes ? opts.initialValue : guard(await p.select(opts));

/** @param {{message:string, initialValue:boolean}} opts */
export const askConfirm = async (opts) =>
  assumeYes ? opts.initialValue : guard(await p.confirm(opts));

/** @param {{message:string, initialValue?:string, placeholder?:string, validate?:(v:string)=>string|undefined}} opts */
export const askText = async (opts) =>
  assumeYes ? (opts.initialValue ?? "") : guard(await p.text(opts));
