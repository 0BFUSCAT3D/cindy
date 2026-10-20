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
final class EphemeralProvider: NSItemProvider {
  var url: URL!
  override func loadItem(forTypeIdentifier identifier: String, options: [AnyHashable: Any]? = nil, completionHandler: NSItemProvider.CompletionHandler? = nil) {
    Thread.current.threadDictionary["owning-provider-callback"] = true
    completionHandler?(url as NSURL, nil)
    Thread.current.threadDictionary.removeObject(forKey: "owning-provider-callback")
    try? FileManager.default.removeItem(at: url)
  }
}
enum ShareType { case text, url, image, video, audio, file }
struct SharePayload { let type: ShareType; let value: String; let mimeType: String?; let metadata: String? }
final class Adapter {
  var requireProviderCallback = false
  func parse(_ provider: NSItemProvider) async -> SharePayload? { await parseProvider(provider) }
  func copyAndProcessFile(url: URL, type: ShareType) -> SharePayload? {
    precondition(!requireProviderCallback || Thread.current.threadDictionary["owning-provider-callback"] as? Bool == true, "URL escaped provider callback")
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
    let selected = CommandLine.arguments[2]
    let link = NSItemProvider()
    let sharedURL = URL(string: "https://example.com/shared-page?source=provider")!
    link.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
      done(Data("link thumbnail".utf8), nil); return nil
    }
    link.registerItem(forTypeIdentifier: UTType.url.identifier, loadHandler: { completion, _, _ in
      completion?(sharedURL as NSURL, nil)
    })
    guard let linked = await adapter.parse(link) else { fatalError("Missing web URL") }
    precondition(linked.type == .url && linked.value == sharedURL.absoluteString && linked.mimeType == "text/uri-list", "Thumbnail replaced web URL")
    print("PASS: web URL survives its image thumbnail")
    if selected != "file-url" {
      for type in [UTType.pdf, .mpeg4Movie] {
        let provider = NSItemProvider()
        let name = "original." + type.preferredFilenameExtension!
        let bytes = Data("original document or movie".utf8)
        provider.suggestedName = name
        // Advertise the thumbnail first, as real source apps may do.
        provider.registerDataRepresentation(forTypeIdentifier: UTType.image.identifier, visibility: .all) { done in
          done(Data("thumbnail".utf8), nil); return nil
        }
        provider.registerDataRepresentation(forTypeIdentifier: type.identifier, visibility: .all) { done in
          done(bytes, nil); return nil
        }
        provider.registerItem(forTypeIdentifier: UTType.url.identifier, loadHandler: { completion, _, _ in
          completion?(sharedURL as NSURL, nil)
        })
        guard let payload = await adapter.parse(provider),
              payload.type == (type.conforms(to: .movie) ? .video : .file),
              let url = URL(string: payload.value) else { fatalError("Thumbnail replaced original export") }
        precondition(url.lastPathComponent == name && payload.mimeType == type.preferredMIMEType)
        precondition(try! Data(contentsOf: url) == bytes)
      }
      let image = NSItemProvider()
      image.suggestedName = "original.png"
      image.registerDataRepresentation(forTypeIdentifier: UTType.png.identifier, visibility: .all) { done in
        done(Data("image bytes".utf8), nil); return nil
      }
      guard let payload = await adapter.parse(image) else { fatalError("Missing image") }
      precondition(payload.type == .image && payload.mimeType == UTType.png.preferredMIMEType)
      print("PASS: original documents/videos beat thumbnails; real images remain images")
    }
    if selected != "thumbnails" {
      let url = root.appendingPathComponent("ephemeral.pdf")
      let bytes = Data("ephemeral bytes".utf8)
      try! bytes.write(to: url)
      let provider = EphemeralProvider()
      provider.url = url
      provider.registerItem(forTypeIdentifier: UTType.fileURL.identifier, loadHandler: { _, _, _ in })
      adapter.requireProviderCallback = true
      guard let payload = await adapter.parse(provider), let result = URL(string: payload.value) else { fatalError("Missing ephemeral file") }
      precondition(try! Data(contentsOf: result) == bytes)
      precondition(!FileManager.default.fileExists(atPath: url.path))
      print("PASS: temporary file URL copied inside provider callback")
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
    ['swiftc', ['-parse-as-library', file, '-o', binary], 60_000],
    [binary, [dir, process.argv[2] ?? "all"], 15_000],
    ['swiftc', [
      join(dirname(fileURLToPath(import.meta.url)), '../modules/cindy-incoming-share/ios/IncomingShareSlot.swift'),
      join(dirname(fileURLToPath(import.meta.url)), 'test-incoming-share-slot.swift'),
      '-o', join(dir, 'slot'),
    ], 30_000],
    [join(dir, 'slot'), [], 15_000],
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
