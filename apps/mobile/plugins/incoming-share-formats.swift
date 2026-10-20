  // Ordered semantic adapters. File-backed content wins over its text/URL preview.
  // Unknown exportable types use their original bytes; new formats normally need
  // no special handler. Add an adapter only when its representation needs decoding.
  private func parseProvider(_ provider: NSItemProvider) async -> SharePayload? {
    if provider.hasItemConformingToTypeIdentifier(UTType.propertyList.identifier),
       let value = await loadShareItem(provider, identifier: UTType.propertyList.identifier) as? [String: Any],
       let page = value[NSExtensionJavaScriptPreprocessingResultsKey] as? [String: Any],
       let url = page["url"] as? String {
      let text = [page["title"] as? String, url, page["selection"] as? String]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      return SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil)
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
      if let value = await loadShareItem(provider, identifier: UTType.fileURL.identifier) as? URL,
         let file = copyAndProcessFile(url: value, type:
           (provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
             || UTType(filenameExtension: value.pathExtension)?.conforms(to: .image) == true) ? .image : .file) { return file }
    }
    let formats: [(UTType, ShareType)] = [(.image, .image), (.movie, .video), (.audio, .audio), (.directory, .file)]
    for (format, kind) in formats where provider.hasItemConformingToTypeIdentifier(format.identifier) {
      if let file = await loadShareFile(provider, format: format, kind: kind) { return file }
    }
    // Prefer an exported document to its plain-text/link preview.
    if let file = await loadShareFile(provider, format: .data, kind: .file, excludePlainText: true) { return file }
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
       let value = await loadShareItem(provider, identifier: UTType.url.identifier) {
      let url = (value as? URL) ?? (value as? String).flatMap(URL.init(string:))
      if let url, !url.isFileURL {
        return SharePayload(type: .url, value: url.absoluteString, mimeType: "text/uri-list", metadata: nil)
      }
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
       let value = await loadShareItem(provider, identifier: UTType.plainText.identifier) {
      let text = (value as? String) ?? (value as? NSAttributedString)?.string
        ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
      if let text, !text.isEmpty {
        return SharePayload(type: .text, value: text, mimeType: "text/plain", metadata: nil)
      }
    }
    // PDF, Office, archives, vCard, calendar, HTML/RTF, models and custom exports.
    return await loadShareFile(provider, format: .data, kind: .file)
  }

  private func loadShareItem(_ provider: NSItemProvider, identifier: String) async -> NSSecureCoding? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: identifier, options: nil) { value, _ in
        continuation.resume(returning: value)
      }
    }
  }

  private func loadShareFile(_ provider: NSItemProvider, format: UTType, kind: ShareType, excludePlainText: Bool = false) async -> SharePayload? {
    let identifiers = provider.registeredTypeIdentifiers.filter {
      let type = UTType($0)
      return type?.conforms(to: format) == true && type?.conforms(to: .url) != true
        && (!excludePlainText || (type?.conforms(to: .plainText) != true && type?.conforms(to: .propertyList) != true))
    }
    for identifier in identifiers {
      // Copy inside the callback: provider-owned URLs expire when it returns.
      var file: SharePayload?
      // UIKit can serialize the abstract public.image representation as an
      // NSKeyedArchive, not image bytes. Decode its UIImage via loadItem below.
      if identifier != UTType.image.identifier {
        file = await withCheckedContinuation { continuation in
          provider.loadFileRepresentation(forTypeIdentifier: identifier) { url, _ in
            continuation.resume(returning: url.flatMap { self.copyAndProcessFile(url: $0, type: kind) })
          }
        }
      }
      if let file { return file }
      guard let value = await loadShareItem(provider, identifier: identifier) else { continue }
      if let url = value as? URL, let file = copyAndProcessFile(url: url, type: kind) { return file }
      let data = (value as? Data) ?? (value as? UIImage)?.pngData()
      if let data {
        let isRenderedImage = value is UIImage
        let type = isRenderedImage ? UTType.png : UTType(identifier)
        let ext = type?.preferredFilenameExtension ?? "bin"
        let suggested = provider.suggestedName.map { URL(fileURLWithPath: $0).lastPathComponent } ?? UUID().uuidString
        let name = suggested.isEmpty || suggested == "." || suggested == ".." ? UUID().uuidString : suggested
        let filename = isRenderedImage ? (name as NSString).deletingPathExtension + ".png"
          : (name as NSString).pathExtension.isEmpty ? name + "." + ext : name
        if let file = saveDataToAppGroup(data: data, fileName: filename, type: kind, mimeType: type?.preferredMIMEType) { return file }
      }
    }
    return nil
  }
