// Execute the production adapter with real NSItemProvider and UTType behavior.
// UIKit image decoding and App Group destinations are outside these file tests.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'darwin') {
  console.error('[share-formats] SKIP: Apple frameworks unavailable');
  process.exit(77);
}
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../plugins/incoming-share-formats.swift'), 'utf8');
const harness = `
import Foundation
import UniformTypeIdentifiers
let testRoot = URL(fileURLWithPath: CommandLine.arguments[1])
let NSExtensionJavaScriptPreprocessingResultsKey = "NSExtensionJavaScriptPreprocessingResultsKey"
class UIImage: NSObject { func pngData() -> Data? { nil } }
enum ShareType { case text, url, image, video, audio, file }
struct SharePayload { let type: ShareType; let value: String; let mimeType: String?; let metadata: String? }
final class Adapter {
  func parse(_ provider: NSItemProvider) async -> SharePayload? { await parseProvider(provider) }
  func copyAndProcessFile(url: URL, type: ShareType) -> SharePayload? {
    guard url.isFileURL, let bytes = try? Data(contentsOf: url) else { return nil }
    return saveDataToAppGroup(data: bytes, fileName: url.lastPathComponent, type: type, mimeType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType)
  }
  func saveDataToAppGroup(data: Data, fileName: String, type: ShareType, mimeType: String?) -> SharePayload? {
    let folder = testRoot.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(fileName)
    try! data.write(to: url)
    return SharePayload(type: type, value: url.absoluteString, mimeType: mimeType, metadata: nil)
  }
  ${source}
}
@main struct FormatTests {
  static func main() async {
    let root = testRoot.appendingPathComponent(UUID().uuidString)
    try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let adapter = Adapter()
    for ext in ["md", "swift"] {
      let type = UTType(filenameExtension: ext)!
      precondition(type.conforms(to: .plainText))
      let url = root.appendingPathComponent("original." + ext)
      let bytes = Data("original file bytes".utf8)
      try! bytes.write(to: url)
      let provider = NSItemProvider()
      provider.suggestedName = url.lastPathComponent
      provider.registerFileRepresentation(forTypeIdentifier: type.identifier, fileOptions: [], visibility: .all) { completion in
        completion(url, false, nil); return nil
      }
      provider.registerDataRepresentation(forTypeIdentifier: UTType.plainText.identifier, visibility: .all) { completion in
        completion(Data("preview only".utf8), nil); return nil
      }
      precondition(!provider.registeredTypeIdentifiers.contains(UTType.fileURL.identifier))
      guard let payload = await adapter.parse(provider), payload.type == .file,
            let result = URL(string: payload.value) else { fatalError("Concrete text became preview: " + ext) }
      precondition(result.lastPathComponent == url.lastPathComponent)
      precondition(payload.mimeType == type.preferredMIMEType)
      precondition(try! Data(contentsOf: result) == bytes)
      try! FileManager.default.removeItem(at: result.deletingLastPathComponent())
    }
    for type in [UTType.plainText, .utf8PlainText, .utf16PlainText, .utf16ExternalPlainText] {
      let provider = NSItemProvider()
      provider.registerItem(forTypeIdentifier: type.identifier, loadHandler: { completion, _, _ in
        completion?("shared passage" as NSString, nil)
      })
      guard let payload = await adapter.parse(provider) else { fatalError("Missing text preview") }
      precondition(payload.type == .text && payload.value == "shared passage")
    }
    print("PASS: concrete Markdown/source files and plain text previews")
  }
}
`;
const dir = mkdtempSync(join(tmpdir(), 'cindy-share-formats-'));
try {
  const file = join(dir, 'Formats.swift');
  const binary = join(dir, 'formats');
  writeFileSync(file, harness);
  for (const [command, args, timeout] of [
    ['swiftc', ['-parse-as-library', file, '-o', binary], 120_000],
    [binary, [dir], 15_000],
  ]) {
    const result = spawnSync(command, args, { stdio: 'inherit', timeout, killSignal: 'SIGKILL' });
    if (result.error?.code === 'ENOENT' && command === 'swiftc') process.exitCode = 77;
    else if (result.error) throw result.error;
    else if (result.status !== 0) process.exitCode = 1;
    if (process.exitCode) break;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
