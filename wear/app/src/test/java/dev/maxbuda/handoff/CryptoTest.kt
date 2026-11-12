package dev.maxbuda.handoff

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pairing derivation and sealing must match the Mac (server/relay.mjs) byte for byte. Expected values are from Node. */
class CryptoTest {
    private fun derive(code: String, info: String, n: Int) =
        Crypto.hkdf(code.toByteArray(), "claude-watch-notes-pair".toByteArray(), info.toByteArray(), n).hex()

    @Test fun hkdfMatchesNode() {
        assertEquals("1dcd7e67611b9f2698fff27d5328955c6ecc92d3ff9286c14974f897ac443463", derive("K7QXM2PA", "key", 32))
        assertEquals("afd43fcce5d6093b1f7efb2e8bc7c74d", derive("K7QXM2PA", "topic", 16))
    }

    @Test fun opensWhatNodeSealed() {
        val key = ByteArray(32) { 7 }
        assertEquals("""{"ack":"abc"}""", String(Crypto.open("AQEBAQEBAQEBAQEBDcPo1Pud1iywtr8DDfF0khL/UdjDa3nHfSRpun4=", key)))
    }

    @Test fun sealsInTheCombinedLayout() {
        val key = ByteArray(32) { 3 }
        val sealed = Crypto.seal("hello".toByteArray(), key)
        assertEquals(12 + 5 + 16, java.util.Base64.getDecoder().decode(sealed).size)
        assertEquals("hello", String(Crypto.open(sealed, key)))
    }

    @Test fun codesUseTheAlphabet() {
        repeat(100) { val c = Pairer.newCode(); assertEquals(8, c.length); assertTrue(c.all { it in Pairer.ALPHABET }) }
        assertEquals("K7QXM2PA", Pairer.normalize("k7qx-m2pa"))
    }
}
