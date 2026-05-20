import AppKit
import MediaPlayer

private func stringFromOptionalPointer(_ pointer: UnsafePointer<CChar>?) -> String? {
    guard let pointer else { return nil }
    let value = String(cString: pointer).trimmingCharacters(in: .whitespacesAndNewlines)
    return value.isEmpty ? nil : value
}

@_cdecl("needle_now_playing_update")
public func needleNowPlayingUpdate(
    titlePointer: UnsafePointer<CChar>,
    artistPointer: UnsafePointer<CChar>?,
    albumPointer: UnsafePointer<CChar>?,
    durationSeconds: Double,
    elapsedSeconds: Double,
    playbackRate: Double,
    artworkBytes: UnsafePointer<UInt8>?,
    artworkLength: Int
) {
    let title = String(cString: titlePointer)
    let artist = stringFromOptionalPointer(artistPointer)
    let album = stringFromOptionalPointer(albumPointer)
    let artworkData = artworkBytes.flatMap { pointer -> Data? in
        guard artworkLength > 0 else { return nil }
        return Data(bytes: pointer, count: artworkLength)
    }

    DispatchQueue.main.async {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
        info[MPMediaItemPropertyTitle] = title
        info[MPMediaItemPropertyArtist] = artist
        info[MPMediaItemPropertyAlbumTitle] = album
        if durationSeconds > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = durationSeconds
        } else {
            info.removeValue(forKey: MPMediaItemPropertyPlaybackDuration)
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, elapsedSeconds)
        info[MPNowPlayingInfoPropertyPlaybackRate] = playbackRate

        if let artworkData, let image = NSImage(data: artworkData) {
            info[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: image.size) { size in
                let scaled = NSImage(size: size)
                scaled.lockFocus()
                image.draw(in: NSRect(origin: .zero, size: size))
                scaled.unlockFocus()
                return scaled
            }
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

@_cdecl("needle_now_playing_update_playback")
public func needleNowPlayingUpdatePlayback(
    durationSeconds: Double,
    elapsedSeconds: Double,
    playbackRate: Double
) {
    DispatchQueue.main.async {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        if durationSeconds > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = durationSeconds
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = max(0, elapsedSeconds)
        info[MPNowPlayingInfoPropertyPlaybackRate] = playbackRate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}

@_cdecl("needle_now_playing_clear")
public func needleNowPlayingClear() {
    DispatchQueue.main.async {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
}
