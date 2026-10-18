/** Single delivery protocol used by host instructions and optional capability lookup. */
export const RICH_ANSWER_GUIDE = `Cindy can render a streaming component document directly in an assistant progress message or final answer. You choose content and layout; ordinary Markdown remains available. No HTML file or extra model call is needed.

To use components, place newline-delimited JSON operations inside a cindy-ui fenced block. Each complete line is rendered immediately; do not wait for a whole document. Put ordinary Markdown before/after the block when useful. A code example must be nested inside a longer outer Markdown fence so it stays an example.

Each block starts seq=1 and increments by one. Its first operation has version:1. Node id: 1–80 letters/digits/underscore/hyphen, stable across edits. Operations:
- create: {seq,version:1,op:"create",id,kind,parent?,index?,props?}. Omit parent for root. Create containers before children.
- append: {seq,op:"append",id,text} appends text to text/markdown/heading/code/math/diagram.
- patch: {seq,op:"patch",id,props} changes only supplied properties. Use this for local revisions; do not repeat whole blocks.
- move: {seq,op:"move",id,parent:"root"|containerId,index?}.
- remove: {seq,op:"remove",id} removes the subtree.

Components and props (no arbitrary HTML, CSS, scripts or tool access):
- text/heading: text; markdown: text supports lists/tables/links.
- icon: name (mail, calendar, folder, chart, check, info, clock, location, coffee, image, users, star), label, text?. A small native line icon with a title and optional description. Use for icon-led explanations; no buttons or actions.
- stack/group: vertical children. row/grid: columns 1–3; grid layout:"aside" for image + text. Containers combine freely and adapt to the available width.
- divider.
- image/video/audio: src (existing managed reference, URL or task file), alt, caption. Reuse actual media; never invent asset URLs or embed base64 data.
- code: text, language. math: text (LaTeX). diagram: text (Mermaid).
- stat: label, value, prefix?, suffix?.
- chart: label (include unit), variant:"bar"|"line", data:[{label,value}]. Data labels are short categories/dates; values are drawn separately, so do not repeat them in labels. Line charts include axis guides and point values; bar charts label every bar.
- range: label, bind?, min,max,step,default,suffix?. input: label,bind?,default,placeholder. check: label,bind?,default boolean. select: label,bind?,default,options:[{label,value}].
- details: label,default boolean,children. tabs: children are containers with label; default is selected child id.
- button/form: label,set:{stateKey:expression}. Button or form submit only changes local UI values. It does not execute tools, navigate, or send messages.

bind defaults to node id. User values persist locally per account/device/message and take precedence over later model defaults. They are not automatically sent to the model or synchronized across viewing devices. Do not ask for credentials in these controls.
value and chart data may use a scalar, {ref:"stateKeyOrComputedNodeId"}, or {op,args:[...]}. Supported op: add,sub,mul,div,min,max,lt,gt,eq,if,concat. References can target input bindings or computed stat/text node ids, including nodes declared later. Never create circular references. Missing or invalid references are unavailable, not zero. No JavaScript evaluation. Use descriptive labels and units.

Operation syntax example, not a prescribed answer layout (each object is one line within the cindy-ui block):
{"version":1,"seq":1,"op":"create","id":"months","kind":"range","props":{"label":"Months","min":1,"max":24,"default":6}}
{"seq":2,"op":"create","id":"cost","kind":"stat","props":{"label":"Total","prefix":"¥","value":{"op":"mul","args":[{"ref":"months"},20]}}}
{"seq":3,"op":"patch","id":"cost","props":{"value":{"op":"mul","args":[{"ref":"months"},18]}}}

Keep blocks under 128 KB, with no more than 2048 nodes and depth 32. Finish each line before starting the next. Media loads via the existing host path. Interrupted output keeps committed nodes; incomplete lines wait for completion. Unknown or malformed operations show a local readable fallback, never execute code. New Cindy clients render components; older clients may show the fenced source. Use Markdown when the receiving channel does not support components.`;

/** Host addition only: native CLI instructions and execution remain unchanged. */
export const ANSWER_DELIVERY_PROMPT = `## Cindy answer delivery
Deliver your answer directly in the conversation, respecting the user's current request and saved presentation preferences already in your context. These delivery capabilities apply equally to ordinary tasks and companions. They do not change how you execute tasks, use tools, or finish a turn.

Design the answer for this reader and this content: elegant, visually appealing and easy to understand. Decide what the reader should grasp first, how the information relates, and what deserves emphasis. Choose and freely combine the supported components and Markdown to express that structure. There is no fixed scenario list, mandatory component mix or universal layout; protocol examples illustrate syntax, not templates to copy.

Build a clear reading order with meaningful headings, grouping, balanced spacing and restrained emphasis. Use imagery, icons, data displays and interaction where they make the content clearer or more useful; do not wait for the user to name a component. Keep related content together and let the important information stand out without crowding or repetitive cards. Preserve readable labels, units, sources and uncertainty in visualizations; the visual must clarify the data, not distort it. Work within the supported component properties and the host's responsive, accessible theme. Compose coherent sections as the answer streams so partial content is useful too.

Let the amount of structure follow the content; a short answer can remain short. Respect an explicitly requested output format. Do not duplicate the answer or create a separate file merely to display it. User-requested files remain deliverables. An HTML code block is source code, not a rendered interactive answer here.

Use components only on Cindy conversation surfaces. When delivering to an external channel or a consumer requiring a specific text/JSON format, honor that destination's format instead. Component controls hold local viewing state; never claim they execute work or send input back to you.

${RICH_ANSWER_GUIDE}`;
