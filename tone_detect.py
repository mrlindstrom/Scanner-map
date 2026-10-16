#!/usr/bin/env python3
"""
tone_detect.py - Two-tone and paging tone detection module
Integrates with icad-tone-detection library for scanner audio analysis
"""

import sys
import json
import logging
import os
import tempfile
from typing import Dict, Any, Optional, List
from pathlib import Path
from urllib.parse import urlparse

try:
    import boto3
    from botocore.exceptions import NoCredentialsError, ClientError
    BOTO3_AVAILABLE = True
except ImportError:
    BOTO3_AVAILABLE = False

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[logging.StreamHandler(sys.stderr)]
)
logger = logging.getLogger(__name__)

try:
    from icad_tone_detection import tone_detect
    logger.info("✓ icad-tone-detection library loaded successfully")
except ImportError as e:
    logger.error(f"ERROR: icad-tone-detection not available: {e}")
    logger.error("Run: pip install icad-tone-detection")
    sys.exit(1)

def download_s3_file(s3_url: str) -> str:
    """Download file from S3 using credentials from environment"""
    if not BOTO3_AVAILABLE:
        raise ImportError("boto3 not available for S3 downloads")
    
    parsed_url = urlparse(s3_url)
    
    # Extract S3 details from URL: https://s3.kinetix.net/bucket-name/key
    endpoint_url = f"{parsed_url.scheme}://{parsed_url.netloc}/"
    path_parts = parsed_url.path.strip('/').split('/', 1)
    
    if len(path_parts) < 2:
        raise ValueError(f"Invalid S3 URL format: {s3_url}")
    
    bucket_name = path_parts[0]
    key = path_parts[1]
    
    logger.info(f"Downloading from S3: bucket={bucket_name}, key={key}")
    
    try:
        # Get S3 credentials from environment
        s3_client = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            aws_access_key_id=os.getenv('S3_ACCESS_KEY_ID'),
            aws_secret_access_key=os.getenv('S3_SECRET_ACCESS_KEY'),
            region_name=os.getenv('S3_REGION', 'us-east-1')
        )
        
        # Create temporary file
        file_extension = Path(key).suffix or '.wav'
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=file_extension)
        temp_file.close()
        
        # Download file from S3
        s3_client.download_file(bucket_name, key, temp_file.name)
        
        file_size = os.path.getsize(temp_file.name)
        logger.info(f"Downloaded {file_size} bytes from S3 to {temp_file.name}")
        
        return temp_file.name
        
    except Exception as e:
        logger.error(f"Failed to download from S3: {e}")
        raise

class ToneDetector:
    """Two-tone detection wrapper for icad-tone-detection library"""
    
    def __init__(self, config: Dict[str, Any] = None):
        """Initialize tone detector with configuration"""
        self.config = config or {}
        
        # Read environment variables and merge with config (env vars take precedence)
        env_config = {}
        env_vars = [
            ('TONE_DETECTION_THRESHOLD', 'matching_threshold', float),
            ('TONE_TIME_RESOLUTION_MS', 'time_resolution_ms', int),
            ('TONE_FREQUENCY_BAND', 'fe_freq_band', str),
            ('TWO_TONE_MIN_TONE_LENGTH', 'tone_a_min_length', float),
            # Legacy name: despite "MAX", this has always been the minimum B-tone length
            ('TWO_TONE_MAX_TONE_LENGTH', 'tone_b_min_length', float),
            ('TWO_TONE_B_MIN_LENGTH', 'tone_b_min_length', float),  # preferred; overrides legacy
            ('TWO_TONE_MAX_GAP_S', 'two_tone_max_gap_between_a_b', float),
            ('TWO_TONE_MIN_PAIR_SEPARATION_HZ', 'two_tone_min_pair_separation_hz', float),
            ('TWO_TONE_BW_HZ', 'two_tone_bw_hz', float),
            ('PULSED_MIN_CYCLES', 'pulsed_min_cycles', int),
            ('PULSED_MIN_ON_MS', 'pulsed_min_on_ms', int),
            ('PULSED_MAX_ON_MS', 'pulsed_max_on_ms', int),
            ('PULSED_MIN_OFF_MS', 'pulsed_min_off_ms', int),
            ('PULSED_MAX_OFF_MS', 'pulsed_max_off_ms', int),
            ('PULSED_BANDWIDTH_HZ', 'pulsed_bw_hz', float),
            ('LONG_TONE_MIN_LENGTH', 'long_tone_min_length', float),
            ('LONG_TONE_BANDWIDTH_HZ', 'long_tone_bw_hz', float),
            ('HI_LOW_INTERVAL_S', 'hi_low_interval', float),
            ('HI_LOW_MIN_ALTERNATIONS', 'hi_low_min_alternations', int),
            ('HI_LOW_BANDWIDTH_HZ', 'hi_low_tone_bw_hz', float),
            ('HI_LOW_MIN_PAIR_SEPARATION_HZ', 'hi_low_min_pair_separation_hz', float),
        ]
        
        for env_var, config_key, type_func in env_vars:
            env_value = os.getenv(env_var)
            # bot.js forwards unset numbers as "NaN"; float("NaN") parses, so reject it explicitly
            if env_value is not None and env_value.strip() not in ('', 'NaN', 'undefined'):
                try:
                    value = type_func(env_value) if type_func is str else type_func(float(env_value))
                    env_config[config_key] = value
                    logger.info(f"Applied env var {env_var}={env_value} -> {config_key}={value}")
                except (ValueError, TypeError):
                    logger.warning(f"Invalid value for {env_var}: {env_value}")
            else:
                logger.info(f"Env var {env_var} not set")
        
        # Hi-low warble is opt-in on top of any TONE_DETECTION_TYPE preset
        detect_hi_low = os.getenv('TONE_DETECT_HI_LOW')
        if detect_hi_low is not None and detect_hi_low.strip() != '':
            env_config['detect_hi_low'] = detect_hi_low.strip().lower() == 'true'
            logger.info(f"Applied env var TONE_DETECT_HI_LOW={detect_hi_low}")

        # Merge: config takes precedence over env, env takes precedence over defaults
        self.config = {**env_config, **self.config}
        
        # Determine detection type from environment or config
        detection_type = os.getenv('TONE_DETECTION_TYPE', self.config.get('detection_type', 'auto'))
        
        # Configuration based on environment variables only - no fallback defaults
        if detection_type == 'auto':
            # Use library defaults - optimized for most scanner recordings
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': True,
                'detect_long': True,
                'detect_hi_low': False,  # Less common
                'detect_mdc': False,     # Less common
                'detect_dtmf': False,    # Less common
                # Use library defaults for all parameters - they work well for most cases
                'matching_threshold': 2.5,
                'time_resolution_ms': 50,
                'fe_freq_band': '200,3000',
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28.0,
                'fe_snr_above_noise_db': 6.0,
                'fe_abs_cap_hz': 30,      # Fixed value to avoid None errors
                'fe_force_split_step_hz': 18,  # Fixed value for better separation
                'fe_split_lookahead_frames': 2,
                # Two-tone defaults
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                # Pulsed defaults
                'pulsed_min_cycles': 6,
                'pulsed_min_on_ms': 120,
                'pulsed_max_on_ms': 900,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 350,
                'pulsed_bw_hz': 25,
                # Long tone defaults (reduced to catch shorter dispatch tones like 0.97s)
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 25
            }
        elif detection_type == 'long':
            self.default_config = {
                'detect_two_tone': False,
                'detect_pulsed': False,
                'detect_long': True,  # Enable long tone detection for continuous tones
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 30,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        elif detection_type == 'pulsed':
            self.default_config = {
                'detect_two_tone': False,
                'detect_pulsed': True,  # Enable pulsed detection for short beeps
                'detect_long': False,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'pulsed_min_cycles': 3,
                'pulsed_min_on_ms': 50,
                'pulsed_max_on_ms': 500,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 800,
                'pulsed_bw_hz': 50,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        elif detection_type == 'both':
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': True,  # Enable all types
                'detect_long': True,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                'pulsed_min_cycles': 3,
                'pulsed_min_on_ms': 50,
                'pulsed_max_on_ms': 500,
                'pulsed_min_off_ms': 25,
                'pulsed_max_off_ms': 800,
                'pulsed_bw_hz': 50,
                'long_tone_min_length': 0.5,
                'long_tone_bw_hz': 30,
                'time_resolution_ms': 25,
                'matching_threshold': 2.0,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        else:  # 'two_tone' (traditional)
            self.default_config = {
                'detect_two_tone': True,
                'detect_pulsed': False,
                'detect_long': False,
                'detect_hi_low': False,
                'detect_mdc': False,
                'detect_dtmf': False,
                'tone_a_min_length': 0.85,
                'tone_b_min_length': 2.6,
                'two_tone_bw_hz': 25,
                'two_tone_min_pair_separation_hz': 40,
                'time_resolution_ms': 50,
                'matching_threshold': 2.5,
                'fe_freq_band': '200,3000',
                # Fix for library bug - set these explicitly
                'fe_force_split_step_hz': 10,
                'fe_split_lookahead_frames': 0,
                'fe_abs_cap_hz': 2000,
                'fe_merge_short_gaps_ms': 0,
                'fe_silence_below_global_db': -28,
                'fe_snr_above_noise_db': 6
            }
        
        # Apply user config over defaults
        self.detection_config = {**self.default_config, **self.config}
        self.detection_config = self._normalize_config(self.detection_config)

        logger.info(f"ToneDetector initialized with config: {self.detection_config}")

    @staticmethod
    def _normalize_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
        """Coerce values into the types icad_tone_detection.tone_detect() expects."""
        cfg = dict(cfg)
        for key in ('fe_freq_band', 'pulsed_auto_center_band'):
            band = cfg.get(key)
            if isinstance(band, str):
                parts = [p for p in band.replace(',', ' ').split() if p]
                try:
                    low, high = float(parts[0]), float(parts[1])
                    if low >= high:
                        raise ValueError
                    cfg[key] = (low, high)
                except (IndexError, ValueError):
                    logger.warning(f"Invalid {key}={band!r}; using 200,3000")
                    cfg[key] = (200.0, 3000.0)
        # Drop keys tone_detect() doesn't accept (e.g. detection_type)
        cfg.pop('detection_type', None)
        return cfg

    def detect_tones_in_file(self, audio_file_path: str) -> Dict[str, Any]:
        """
        Detect dispatch tones (two-tone, hi-low warble, long, pulsed) in an audio file.

        Returns a JSON-serializable dict:
          has_two_tone   - True if any enabled tone type was found (name kept for compatibility)
          detected_type  - "two-tone", "hi-low", "pulsed", "long" or a "+"-joined combination
          detected_tones - flat list of library hits, each tagged with 'type'
          results        - raw library hits per type
        """
        logger.info(f"Analyzing audio file for tones: {audio_file_path}")

        local_file_path = audio_file_path
        temp_file_created = False

        try:
            if audio_file_path.startswith('https://') and 's3' in audio_file_path:
                local_file_path = download_s3_file(audio_file_path)
                temp_file_created = True
                logger.info(f"Downloaded S3 file to: {local_file_path}")
            elif not audio_file_path.startswith(('http://', 'https://')) and not os.path.exists(audio_file_path):
                return {
                    'error': f'Local audio file not found: {audio_file_path}',
                    'has_two_tone': False,
                    'detected_tones': [],
                    'file_path': audio_file_path
                }

            # tone_detect() returns ToneDetectionResult whose fields are lists of dicts
            result = tone_detect(local_file_path, **self.detection_config)
            results = {
                'two_tone': list(result.two_tone_result or []),
                'pulsed': list(result.pulsed_result or []),
                'long': list(result.long_result or []),
                'hi_low': list(result.hi_low_result or []),
            }

            detected_tones = []
            detected_types = []
            for tone_type, label in (('two_tone', 'two-tone'), ('hi_low', 'hi-low'), ('pulsed', 'pulsed'), ('long', 'long')):
                hits = results[tone_type]
                if not hits:
                    continue
                detected_types.append(label)
                for hit in hits:
                    detected_tones.append({**hit, 'type': label})
                    logger.info(f"{label} detected: {hit}")

            has_tone = bool(detected_tones)
            if not has_tone:
                logger.info("No dispatch tones detected")

            return {
                'has_two_tone': has_tone,
                'detected_type': '+'.join(detected_types) if detected_types else None,
                'detected_tones': detected_tones,
                'results': results,
                'file_path': audio_file_path,
            }

        except Exception as e:
            error_msg = f"Error during tone detection: {type(e).__name__}: {e}"
            logger.error(error_msg)
            return {
                'error': error_msg,
                'has_two_tone': False,
                'detected_tones': [],
                'file_path': audio_file_path
            }
        finally:
            if temp_file_created and os.path.exists(local_file_path):
                try:
                    os.unlink(local_file_path)
                    logger.info(f"Cleaned up temporary file: {local_file_path}")
                except Exception:
                    pass  # Ignore cleanup errors

    def get_detected_tones(self, detection_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Flat list of detected tones from detect_tones_in_file()."""
        return detection_result.get('detected_tones', [])


def create_detector_from_env() -> ToneDetector:
    """Create a ToneDetector instance using environment variables from Node.js"""
    
    # These will be passed from the Node.js process via command line or stdin
    config = {}
    
    # We'll receive configuration from the parent process
    return ToneDetector(config)

def main():
    """Main function for standalone testing"""
    if len(sys.argv) < 2:
        print("Usage: python tone_detect.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    
    audio_file = sys.argv[1]
    
    # Create detector with default configuration
    detector = ToneDetector()
    
    # Detect tones
    result = detector.detect_tones_in_file(audio_file)
    
    # Print results as JSON
    print(json.dumps(result, indent=2))
    
    # Get detected tone frequencies
    tones = detector.get_detected_tones(result)
    if tones:
        print(f"\nDetected {len(tones)} two-tone sequence(s):", file=sys.stderr)
        for i, tone_pair in enumerate(tones):
            print(f"  {i+1}: {tone_pair['tone_a']:.1f}Hz → {tone_pair['tone_b']:.1f}Hz", file=sys.stderr)

if __name__ == "__main__":
    main()
