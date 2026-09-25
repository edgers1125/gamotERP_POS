package com.medsource.gamoterp.posdevice

import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import com.google.android.play.core.integrity.IntegrityManagerFactory
import com.google.android.play.core.integrity.StandardIntegrityManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

// The GamotERP POS device key (docs/plans/pos-android-app.md, "Security model"): one EC P-256 signing key in the
// Android Keystore under a fixed alias — StrongBox when the device has it, else the TEE, else (emulators) whatever the
// Keystore gives — never exportable. Created with the server's enrollment challenge as the attestation challenge so the
// server can verify the chain up to Google's hardware attestation root.

private const val KEY_ALIAS = "gamoterp_pos_device_key_v1"
private const val ANDROID_KEYSTORE = "AndroidKeyStore"
private const val TAG = "PosDevice"
private const val COORDINATE_SIZE = 32 // P-256

internal class NoDeviceKeyException :
  CodedException("No POS device key on this device — enroll the device first")

internal class KeyCreationException(message: String?, cause: Throwable? = null) :
  CodedException("Could not create the POS device key: ${message ?: "unknown error"}", cause)

internal class SigningException(message: String?, cause: Throwable? = null) :
  CodedException("Could not sign with the POS device key: ${message ?: "unknown error"}", cause)

internal class InvalidChallengeException :
  CodedException("The enrollment challenge is not valid base64url")

class PosDeviceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PosDevice")

    AsyncFunction("hasKey") {
      return@AsyncFunction keyStore().containsAlias(KEY_ALIAS)
    }

    // Replaces any existing key. Returns { publicJwk, attestationChain (leaf first, base64 DER — [] when the key could
    // not be attested), securityLevel ("STRONGBOX" | "TEE" | "SOFTWARE"), attested }.
    AsyncFunction("createKey") { challengeBase64Url: String ->
      val challenge = try {
        Base64.decode(challengeBase64Url, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
      } catch (e: IllegalArgumentException) {
        throw InvalidChallengeException()
      }
      if (challenge.isEmpty()) throw InvalidChallengeException()
      return@AsyncFunction createKey(challenge)
    }

    AsyncFunction("getPublicJwk") {
      val ks = keyStore()
      if (!ks.containsAlias(KEY_ALIAS)) return@AsyncFunction null
      val publicKey = ks.getCertificate(KEY_ALIAS)?.publicKey as? ECPublicKey ?: return@AsyncFunction null
      return@AsyncFunction jwkOf(publicKey)
    }

    // ES256 over the given bytes; returns the JOSE signature (raw r||s, 64 bytes) as base64url.
    AsyncFunction("sign") { data: ByteArray ->
      val privateKey = keyStore().getKey(KEY_ALIAS, null) as? PrivateKey ?: throw NoDeviceKeyException()
      val der = try {
        Signature.getInstance("SHA256withECDSA").run {
          initSign(privateKey)
          update(data)
          sign()
        }
      } catch (e: Exception) {
        throw SigningException(e.message, e)
      }
      val raw = try {
        derToJose(der)
      } catch (e: Exception) {
        throw SigningException("unexpected signature encoding", e)
      }
      return@AsyncFunction base64Url(raw)
    }

    AsyncFunction("deleteKey") {
      val ks = keyStore()
      if (ks.containsAlias(KEY_ALIAS)) {
        ks.deleteEntry(KEY_ALIAS)
      }
      Unit
    }

    AsyncFunction("getDeviceInfo") {
      val context = appContext.reactContext
      val strongBox = context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE) ?: false
      val manufacturer = Build.MANUFACTURER?.trim().orEmpty()
      val model = Build.MODEL?.trim().orEmpty()
      val name = when {
        model.isEmpty() -> manufacturer
        manufacturer.isEmpty() || model.startsWith(manufacturer, ignoreCase = true) -> model
        else -> "$manufacturer $model"
      }
      return@AsyncFunction mapOf(
        "model" to name.ifEmpty { null },
        "androidSdk" to Build.VERSION.SDK_INT,
        "strongBox" to strongBox,
      )
    }

    // Play Integrity standard request. Resolves null (never rejects) when Play Integrity is unavailable (no Play Store,
    // emulator without Google Play, not configured, network…) — the server decides whether it needed one.
    AsyncFunction("requestIntegrityToken") { requestHash: String, cloudProjectNumber: String, promise: Promise ->
      val projectNumber = cloudProjectNumber.trim().toLongOrNull()
      val context = appContext.reactContext
      if (projectNumber == null || projectNumber <= 0L || context == null || requestHash.isEmpty()) {
        promise.resolve(null)
      } else {
        try {
          val manager = IntegrityManagerFactory.createStandard(context.applicationContext)
          manager
            .prepareIntegrityToken(
              StandardIntegrityManager.PrepareIntegrityTokenRequest.builder()
                .setCloudProjectNumber(projectNumber)
                .build()
            )
            .addOnSuccessListener { provider ->
              try {
                provider
                  .request(
                    StandardIntegrityManager.StandardIntegrityTokenRequest.builder()
                      .setRequestHash(requestHash)
                      .build()
                  )
                  .addOnSuccessListener { response -> promise.resolve(response.token()) }
                  .addOnFailureListener { e ->
                    Log.w(TAG, "Play Integrity token request failed", e)
                    promise.resolve(null)
                  }
              } catch (e: Exception) {
                Log.w(TAG, "Play Integrity token request failed", e)
                promise.resolve(null)
              }
            }
            .addOnFailureListener { e ->
              Log.w(TAG, "Play Integrity prepare failed", e)
              promise.resolve(null)
            }
        } catch (e: Exception) {
          Log.w(TAG, "Play Integrity unavailable", e)
          promise.resolve(null)
        }
      }
      Unit
    }
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

  private fun createKey(challenge: ByteArray): Map<String, Any?> {
    val ks = keyStore()
    val context = appContext.reactContext
    val hasStrongBox = context?.packageManager?.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE) ?: false

    // Attempts, best first: StrongBox + attestation → TEE + attestation → no attestation (emulators whose Keystore
    // can't attest; the server accepts that only in DEV mode).
    data class Attempt(val strongBox: Boolean, val attest: Boolean)
    val attempts = buildList {
      if (hasStrongBox) add(Attempt(strongBox = true, attest = true))
      add(Attempt(strongBox = false, attest = true))
      add(Attempt(strongBox = false, attest = false))
    }

    var lastError: Exception? = null
    for (attempt in attempts) {
      if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
      try {
        val builder = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN)
          .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
          .setDigests(KeyProperties.DIGEST_SHA256)
        if (attempt.attest) builder.setAttestationChallenge(challenge)
        if (attempt.strongBox) builder.setIsStrongBoxBacked(true)
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        generator.initialize(builder.build())
        val pair = generator.generateKeyPair()

        val chain = ks.getCertificateChain(KEY_ALIAS)?.toList().orEmpty()
        // A real attestation chain has the leaf plus at least one issuer; a lone self-signed certificate is not one.
        val attested = attempt.attest && chain.size >= 2
        val chainBase64 = if (attested) chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) } else emptyList()
        val publicKey = (chain.firstOrNull()?.publicKey ?: pair.public) as ECPublicKey
        return mapOf(
          "publicJwk" to jwkOf(publicKey),
          "attestationChain" to chainBase64,
          "securityLevel" to securityLevelOf(pair.private, attempt.strongBox),
          "attested" to attested,
        )
      } catch (e: StrongBoxUnavailableException) {
        lastError = e
      } catch (e: ProviderException) {
        // e.g. "Failed to generate attestation" on some emulators / devices without attestation keys.
        lastError = e
      } catch (e: Exception) {
        lastError = e
      }
      Log.w(TAG, "Key generation attempt failed (strongBox=${attempt.strongBox}, attest=${attempt.attest})", lastError)
    }
    if (ks.containsAlias(KEY_ALIAS)) ks.deleteEntry(KEY_ALIAS)
    throw KeyCreationException(lastError?.message, lastError)
  }

  @Suppress("DEPRECATION")
  private fun securityLevelOf(privateKey: PrivateKey, requestedStrongBox: Boolean): String {
    return try {
      val info = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE)
        .getKeySpec(privateKey, KeyInfo::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        when (info.securityLevel) {
          KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
          KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT, KeyProperties.SECURITY_LEVEL_UNKNOWN_SECURE -> "TEE"
          else -> "SOFTWARE"
        }
      } else {
        when {
          !info.isInsideSecureHardware -> "SOFTWARE"
          requestedStrongBox -> "STRONGBOX"
          else -> "TEE"
        }
      }
    } catch (e: Exception) {
      if (requestedStrongBox) "STRONGBOX" else "SOFTWARE"
    }
  }

  private fun jwkOf(publicKey: ECPublicKey): Map<String, Any?> = mapOf(
    "kty" to "EC",
    "crv" to "P-256",
    "x" to base64Url(unsignedFixed(publicKey.w.affineX, COORDINATE_SIZE)),
    "y" to base64Url(unsignedFixed(publicKey.w.affineY, COORDINATE_SIZE)),
  )

  private fun base64Url(bytes: ByteArray): String =
    Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  private fun unsignedFixed(value: BigInteger, size: Int): ByteArray = fixedSize(value.toByteArray(), size)

  // Big-endian unsigned integer bytes → exactly `size` bytes (drops sign/leading zeros, left-pads with zeros).
  private fun fixedSize(src: ByteArray, size: Int): ByteArray {
    var start = 0
    while (start < src.size - 1 && src[start] == 0.toByte()) start++
    val length = src.size - start
    if (length > size) throw IllegalArgumentException("integer longer than $size bytes")
    val out = ByteArray(size)
    System.arraycopy(src, start, out, size - length, length)
    return out
  }

  // ASN.1 DER ECDSA-Sig-Value SEQUENCE { r INTEGER, s INTEGER } → JOSE r||s (RFC 7518 §3.4).
  private fun derToJose(der: ByteArray): ByteArray {
    var pos = 0
    fun readByte(): Int {
      if (pos >= der.size) throw IllegalArgumentException("truncated DER")
      return der[pos++].toInt() and 0xff
    }
    fun readLength(): Int {
      val first = readByte()
      if (first and 0x80 == 0) return first
      val count = first and 0x7f
      if (count == 0 || count > 2) throw IllegalArgumentException("bad DER length")
      var length = 0
      repeat(count) { length = (length shl 8) or readByte() }
      return length
    }
    fun readInteger(): ByteArray {
      if (readByte() != 0x02) throw IllegalArgumentException("expected INTEGER")
      val length = readLength()
      if (length <= 0 || pos + length > der.size) throw IllegalArgumentException("bad INTEGER length")
      val value = der.copyOfRange(pos, pos + length)
      pos += length
      return value
    }
    if (readByte() != 0x30) throw IllegalArgumentException("expected SEQUENCE")
    readLength()
    val r = readInteger()
    val s = readInteger()
    val out = ByteArray(COORDINATE_SIZE * 2)
    System.arraycopy(fixedSize(r, COORDINATE_SIZE), 0, out, 0, COORDINATE_SIZE)
    System.arraycopy(fixedSize(s, COORDINATE_SIZE), 0, out, COORDINATE_SIZE, COORDINATE_SIZE)
    return out
  }
}
