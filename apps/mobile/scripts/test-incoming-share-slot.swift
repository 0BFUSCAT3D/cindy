// Compile alongside modules/cindy-incoming-share/ios/IncomingShareSlot.swift.
import Foundation
import Darwin

@main
enum IncomingShareSlotTest {
  static func main() throws {
    let arguments = CommandLine.arguments
    if arguments.count > 1 && arguments[1] == "--rejected" {
      let persisted = UserDefaults(suiteName: arguments[2])!
      precondition(persisted.synchronize())
      precondition(IncomingShareSlot.read(Data("A".utf8), rejections: persisted) { _ in throw POSIXError(.EIO) } == nil)
      return
    }
    if arguments.count > 1 {
      let lock = URL(fileURLWithPath: arguments[1])
      // Prove that the other process cannot enter the compare/clear window.
      let fd = open(lock.path, O_RDWR)
      precondition(fd >= 0)
      precondition(flock(fd, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK)
      close(fd)
      FileHandle.standardOutput.write(Data([1]))
      try IncomingShareSlot.withLock(at: lock) {
        let defaults = UserDefaults(suiteName: arguments[2])!
        precondition(defaults.synchronize())
        defaults.set(Data("B".utf8), forKey: IncomingShareSlot.key)
        precondition(defaults.synchronize())
      }
      return
    }

    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let suite = "cindy-share-test-" + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite); defaults.synchronize() }
    let lock = root.appendingPathComponent("slot.lock")
    let a = Data("A".utf8)
    let b = Data("B".utf8)
    defaults.set(a, forKey: IncomingShareSlot.key)
    precondition(defaults.synchronize())

    let writer = Process()
    writer.executableURL = URL(fileURLWithPath: arguments[0])
    writer.arguments = [lock.path, suite]
    let ready = Pipe()
    writer.standardOutput = ready
    try IncomingShareSlot.withLock(at: lock) {
      precondition(defaults.data(forKey: IncomingShareSlot.key) == a)
      try writer.run()
      precondition(ready.fileHandleForReading.readData(ofLength: 1) == Data([1]))
      // B has attempted to write after comparison. It must wait for clearing A.
      let cleared = try IncomingShareSlot.clear(a, from: defaults)
      precondition(cleared)
    }
    writer.waitUntilExit()
    precondition(writer.terminationStatus == 0)
    try IncomingShareSlot.withLock(at: lock) {
      precondition(defaults.synchronize())
      precondition(defaults.data(forKey: IncomingShareSlot.key) == b)
      let staleCleared = try IncomingShareSlot.clear(a, from: defaults)
      precondition(!staleCleared && defaults.data(forKey: IncomingShareSlot.key) == b)
      let currentCleared = try IncomingShareSlot.clear(b, from: defaults)
      let duplicateCleared = try IncomingShareSlot.clear(b, from: defaults)
      precondition(currentCleared && !duplicateCleared)
    }
    // An error must release the lock as well.
    do { try IncomingShareSlot.withLock(at: lock) { throw POSIXError(.EIO) } } catch {}
    try IncomingShareSlot.withLock(at: lock) {}
    let rejectionSuite = suite + "-rejections"
    let rejections = UserDefaults(suiteName: rejectionSuite)!
    defer { rejections.removePersistentDomain(forName: rejectionSuite); rejections.synchronize() }
    do {
      _ = try IncomingShareSlot.discard(a, rejections: rejections) { _ in throw POSIXError(.EIO) }
      fatalError("Expected failed App Group cleanup")
    } catch {}
    let reader = Process()
    reader.executableURL = URL(fileURLWithPath: arguments[0])
    reader.arguments = ["--rejected", rejectionSuite]
    try reader.run()
    reader.waitUntilExit()
    precondition(reader.terminationStatus == 0)
    // A fresh instance models restart after account A's App Group clear failed.
    let restarted = UserDefaults(suiteName: rejectionSuite)!
    for _ in 0..<2 {
      precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in throw POSIXError(.EIO) } == nil)
    }
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in true } == nil)
    // Clearing succeeded: a deliberate identical share is eligible again.
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in fatalError("Not rejected") } == a)
    try IncomingShareSlot.reject(a, in: rejections)
    precondition(IncomingShareSlot.read(b, rejections: restarted) { _ in fatalError("Never clear newer bytes") } == b)
    let discarded = try IncomingShareSlot.discard(a, rejections: rejections) { _ in true }
    precondition(discarded)
    precondition(IncomingShareSlot.read(a, rejections: restarted) { _ in fatalError("Already cleared") } == a)
    print("PASS: durable exact-snapshot rejection, retry and replacement")
    print("PASS: cross-process exclusion, stale/current/duplicate acknowledgement, error unlock")
  }
}
