package dev.maxbuda.handoff

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.NamedParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.KeyAgreement

// Experimental: pairing without a code. `handoff pair --nearby` on the Mac announces it on the local
// network (Bonjour, _handoff._tcp); we find it, agree on a key with X25519 over plain HTTP, and both
// show a 6-digit number from it. You check they match on the Mac (that's what stops someone else on
// the network from pairing in the middle); then we send the same offer as Pairer.pair, sealed with
// that key, and get the same ack. See "pair nearby" in server/handoff.mjs.

/** A Mac running `handoff pair --nearby` on this network. */
data class NearbyMac(val name: String, val host: String, val port: Int)

object Nearby {
    private const val TYPE = "_handoff._tcp."

    /** The Macs announcing themselves, updated as they come and go. */
    fun macs(context: Context): Flow<List<NearbyMac>> = callbackFlow {
        val nsd = context.getSystemService(NsdManager::class.java)
        val found = linkedMapOf<String, NearbyMac>()
        val resolving = Executors.newSingleThreadExecutor()
        val callbacks = mutableListOf<NsdManager.ServiceInfoCallback>()
        val discovery = object : NsdManager.DiscoveryListener {
            override fun onServiceFound(info: NsdServiceInfo) {
                val cb = object : NsdManager.ServiceInfoCallback {
                    override fun onServiceUpdated(s: NsdServiceInfo) {
                        val host = s.hostAddresses.firstOrNull { it is java.net.Inet4Address } ?: s.hostAddresses.firstOrNull() ?: return
                        found[s.serviceName] = NearbyMac(s.serviceName, host.hostAddress ?: return, s.port)
                        trySend(found.values.toList())
                    }
                    override fun onServiceLost() { found.remove(info.serviceName); trySend(found.values.toList()) }
                    override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) {}
                    override fun onServiceInfoCallbackUnregistered() {}
                }
                callbacks += cb
                runCatching { nsd.registerServiceInfoCallback(info, resolving, cb) }
            }
            override fun onServiceLost(info: NsdServiceInfo) { found.remove(info.serviceName); trySend(found.values.toList()) }
            override fun onDiscoveryStarted(type: String) { trySend(emptyList()) }
            override fun onDiscoveryStopped(type: String) {}
            override fun onStartDiscoveryFailed(type: String, code: Int) { close() }
            override fun onStopDiscoveryFailed(type: String, code: Int) {}
        }
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discovery)
        awaitClose {
            callbacks.forEach { runCatching { nsd.unregisterServiceInfoCallback(it) } }
            runCatching { nsd.stopServiceDiscovery(discovery) }
            resolving.shutdown()
        }
    }

    /** After hello: the key both sides derived, and the number both show. */
    class Session(val mac: NearbyMac, val key: ByteArray, val sas: String)

    /** Swaps public keys with the Mac and derives the session key and the number to compare. */
    suspend fun hello(mac: NearbyMac): Session? {
        val pair = KeyPairGenerator.getInstance("XDH").apply { initialize(NamedParameterSpec.X25519) }.generateKeyPair()
        val myPub = pair.public.encoded // X.509 SubjectPublicKeyInfo, as Node's 'spki' DER
        val req = Request.Builder().url("http://${mac.host}:${mac.port}/hello")
            .post(JSONObject().put("pub", myPub.b64()).toString().toRequestBody("application/json".toMediaType())).build()
        val res = Relay.call(req) ?: return null
        val macPub = runCatching { Base64.getDecoder().decode(JSONObject(res).getString("pub")) }.getOrNull() ?: return null
        val shared = KeyAgreement.getInstance("XDH").run {
            init(pair.private)
            doPhase(KeyFactory.getInstance("XDH").generatePublic(X509EncodedKeySpec(macPub)), true)
            generateSecret()
        }
        val (key, sas) = derive(shared, myPub, macPub)
        return Session(mac, key, sas)
    }

    /** The session key and the 6-digit number, from the X25519 secret and both public keys (as the Mac does). */
    fun derive(shared: ByteArray, watchPub: ByteArray, macPub: ByteArray): Pair<ByteArray, String> {
        fun hkdf(info: ByteArray, n: Int) = Crypto.hkdf(shared, "handoff-nearby".toByteArray(), info, n)
        val number = java.nio.ByteBuffer.wrap(hkdf("sas".toByteArray() + watchPub + macPub, 4)).int.toLong() and 0xffffffffL
        return hkdf("key".toByteArray(), 32) to "%06d".format(number % 1_000_000)
    }

    /**
     * Sends our topic and key, sealed with the session key, and waits (up to 3 minutes) for you to
     * confirm the number on the Mac. Returns the pairing, or null if the Mac refused or didn't answer.
     */
    suspend fun offer(s: Session): Pairing? {
        val topic = "cw-${Crypto.randomBytes(16).hex()}"
        val pairing = Pairing("${Relay.base}/$topic", Crypto.randomBytes(32))
        val nonce = Crypto.randomBytes(16).hex()
        val offer = JSONObject().put("topic", pairing.topicURL).put("key", pairing.key.b64()).put("n", nonce).put("moves", true)
        val req = Request.Builder().url("http://${s.mac.host}:${s.mac.port}/offer")
            .post(Crypto.seal(offer.toString().toByteArray(), s.key).toRequestBody("text/plain".toMediaType())).build()
        val sealed = Relay.call(req, waitFor = 3 * 60) ?: return null
        val ack = runCatching { JSONObject(String(Crypto.open(sealed, s.key))) }.getOrNull() ?: return null
        if (ack.optString("ack") != nonce) return null
        val own = Pairer.ownRelay(ack.optString("relay"))
        return if (own != null) Pairing("$own/$topic", pairing.key) else pairing
    }
}
