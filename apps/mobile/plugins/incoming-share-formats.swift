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
      if let file = await loadSharePayload(provider, identifier: UTType.fileURL.identifier) { return file }
    }
    let formats: [(UTType, ShareType)] = [(.movie, .video), (.audio, .audio), (.directory, .file)]
    for (format, kind) in formats where provider.hasItemConformingToTypeIdentifier(format.identifier) {
      if let file = await loadShareFile(provider, format: format, kind: kind) { return file }
    }
    // Concrete exports (including ordinary property lists) win over previews.
    // Only the positively identified Safari envelope above is composer text.
    if let file = await loadShareFile(provider, format: .data, kind: .file, excludePlainText: true, excludeImages: true) { return file }
    // Web links may also advertise a thumbnail; retain the actionable URL.
    if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
       let value = await loadShareItem(provider, identifier: UTType.url.identifier) {
      let text = (value as? String) ?? (value as? Data).flatMap { String(data: $0, encoding: .utf8) }
      let url = (value as? URL) ?? text.flatMap(URL.init(string:))
      if let url, !url.isFileURL {
        return SharePayload(type: .url, value: url.absoluteString, mimeType: "text/uri-list", metadata: nil)
      }
    }
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
       let image = await loadShareFile(provider, format: .image, kind: .image) { return image }
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

  private func loadShareFile(_ provider: NSItemProvider, format: UTType, kind: ShareType, excludePlainText: Bool = false, excludeImages: Bool = false) async -> SharePayload? {
    // These exact representations are text previews. Concrete subtypes such as
    // Markdown and source code also conform to plainText, but remain files.
    let textPreviews = [UTType.plainText, .utf8PlainText, .utf16PlainText, .utf16ExternalPlainText]
      .map(\.identifier)
    let identifiers = provider.registeredTypeIdentifiers.filter {
      let type = UTType($0)
      return type?.conforms(to: format) == true && type?.conforms(to: .url) != true
        && (!excludePlainText || !textPreviews.contains($0))
        && (!excludeImages || ($0 != UTType.data.identifier && type?.conforms(to: .image) != true))
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
      if let file = await loadSharePayload(provider, identifier: identifier, kind: kind) { return file }
    }
    return nil
  }

  private func loadSharePayload(_ provider: NSItemProvider, identifier: String, kind: ShareType? = nil) async -> SharePayload? {
    await withCheckedContinuation { continuation in
      provider.loadItem(forTypeIdentifier: identifier, options: nil) { value, _ in
        // URL lifetime belongs to this callback, including loadItem fallbacks.
        if let url = value as? URL {
          let image = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image)
            ?? provider.hasItemConformingToTypeIdentifier(UTType.image.identifier)
          continuation.resume(returning: self.copyAndProcessFile(url: url, type: kind ?? (image ? .image : .file)))
          return
        }
        guard let kind, let data = (value as? Data) ?? (value as? UIImage)?.pngData() else {
          continuation.resume(returning: nil)
          return
        }
        let isRenderedImage = value is UIImage
        let type = isRenderedImage ? UTType.png : UTType(identifier)
        let ext = type?.preferredFilenameExtension ?? "bin"
        let suggested = provider.suggestedName.map { URL(fileURLWithPath: $0).lastPathComponent } ?? UUID().uuidString
        let name = suggested.isEmpty || suggested == "." || suggested == ".." ? UUID().uuidString : suggested
        let filename = isRenderedImage ? (name as NSString).deletingPathExtension + ".png"
          : (name as NSString).pathExtension.isEmpty ? name + "." + ext : name
        continuation.resume(returning: self.saveDataToAppGroup(data: data, fileName: filename, type: kind, mimeType: type?.preferredMIMEType))
      }
    }
  }
