#include <esp_now.h>
#include <esp_wifi.h>
#include <WiFi.h>
#include <ADS8688.h>

#define SHOW_SUCCESS 0
#define PIN_CS 7
#define PIN_SCK 6
#define PIN_MOSI 5
#define PIN_MISO 4

#define DEFAULT_OFFSET 0
#define DIVIDER_OFFSET 0

#define ADS8688_SPI_CLOCK 20000000
#define SAMPLING_RATE 1200
//#define SAMPLING_RATE 10

/*
-------------------
BENCHMARKING TEST
-------------------
// ESP32 C3 only single core, cannot read from adc while writing
// Max recorded transfer speed 630KB/s (163kSPS or 163kHz)
// Pkt size = 5, Flushing into CSV at 1000 count, reading at 5-50 packets (8 samples per packet)
// Max benchmark without serial write 5000 rows * 8 ch = 155ms (258kSPS or 258kHz)
*/
#define PACKET_SIZE 6

ADS8688 adc(PIN_CS, PIN_SCK, PIN_MOSI, PIN_MISO);

uint32_t header;  // 1347896658
char role[4] = { 'P', 'W', 'E', 'R' };

struct __attribute__((packed)) Packet {
  uint32_t header;
  uint16_t counter;
  uint32_t timediff_us;
  uint16_t readings[8];
  uint16_t chksum;
};
Packet bulkPacket[PACKET_SIZE];

const uint8_t R1_SIZE = 6;
const uint8_t R5_SIZE = 2;
const uint8_t r1_pins[R1_SIZE] = { 0, 1, 2, 3, 4, 5 };  // Direct HE sensor reading
const uint8_t r5_pins[R5_SIZE] = { 6, 7 };              // Battery voltage stepped down

uint16_t raw_readings[8];
uint32_t prevTime_us;
uint16_t counter = 1;
uint16_t packet_position = 0;
uint16_t timer_start;

uint32_t str_to_u32(const char s[4]) {
  return ((uint32_t)s[3] << 24) | ((uint32_t)s[2] << 16) | ((uint32_t)s[1] << 8) | ((uint32_t)s[0]);
}

uint16_t additive_chksum(uint16_t *readings, uint16_t counter) {
  uint16_t sum = counter;
  for (int i = 0; i < 8; i++) {
    sum ^= readings[i] << (i + 1);
  }
  return sum;
}

bool init_ADS8688() {
  header = str_to_u32(role);

  for (int i = 0; i < R1_SIZE; i++) {
    adc.setChannelRange(r1_pins[i], R1);
  }

  for (int i = 0; i < R5_SIZE; i++) {
    adc.setChannelRange(r5_pins[i], R5);
  }

  adc.setChannelSequence(0xFF);  // or 0b11111111 (not x but b)
  adc.setSampleRate(SAMPLING_RATE);
  adc.autoRst();

  SPI.beginTransaction(SPISettings(ADS8688_SPI_CLOCK, MSBFIRST, SPI_MODE1));

  prevTime_us = micros();
  timer_start = millis();
  return true;
}

uint8_t boadcastAddr[] = { 0xac, 0xeb, 0xe6, 0x49, 0xc7, 0xcc };
esp_now_peer_info_t peerInfo;

bool init_ESP_NOW() {
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP now failed to initialise");
    return false;
  }

  esp_now_register_send_cb(esp_now_send_cb_t(onESPNowSent));

  memcpy(peerInfo.peer_addr, boadcastAddr, 6);

  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add receiving device");
    return false;
  }

  return true;
}

void onESPNowSent(const uint8_t *mac_addr, esp_now_send_status_t status) {
#if SHOW_SUCCESS
  if (status == ESP_NOW_SEND_SUCCESS) {
    Serial.println("Delivery Success")
  }
#endif
  if (status != ESP_NOW_SEND_SUCCESS) {
    Serial.println("Delivery Fail");
  }
}

int channel_offsets[8] = { 0 };
const uint16_t R1_OFFSET_THRESHOLD = 200;
const uint16_t R5_OFFSET_THRESHOLD = 200;
const uint8_t OFFSET_DIFF_THRESHOLD = 50;

void setup() {
  Serial.begin(2000000);

  WiFi.mode(WIFI_STA);

  while (!init_ESP_NOW()) {
    delay(100);
  }

  while (!init_ADS8688()) {
    delay(100);
  }
  Serial.println("Finished setup");
}

void IRAM_ATTR loop() {
  while (packet_position < PACKET_SIZE) {
    adc.waitForSample();  // Limit sampling rate. If sampling rate set to 0, no effect

    uint32_t now_us = adc.readAllChannels(raw_readings);

    Packet &currPkt = bulkPacket[packet_position];
    currPkt.counter = counter;
    currPkt.timediff_us = now_us - prevTime_us;

    for (int i = 0; i < R1_SIZE; i++) {
      uint8_t idx = r1_pins[i];
      int diff = raw_readings[idx] - 32768;
      if (abs(diff) < R1_OFFSET_THRESHOLD) {
        if (channel_offsets[idx] == 0) {
          channel_offsets[idx] = diff;
        } else if (abs(diff - channel_offsets[idx]) < OFFSET_DIFF_THRESHOLD) {
          // Update offset if the new reading is close to the current offset
          channel_offsets[idx] = (channel_offsets[idx] + diff) / 2;
        }
      }

      uint16_t raw = raw_readings[idx];
      int total_offset = DEFAULT_OFFSET + channel_offsets[idx];
      if (raw < total_offset) {
        raw = 0;
      } else if (raw > 65535 - total_offset) {
        raw = 65535;
      } else {
        raw -= total_offset;
      }
      // Ranges from -5.12 to +5.12V
      // Add a function to recalculate offset when close to 0 reading
      currPkt.readings[idx] = raw;
      //Serial.print(idx); Serial.print(" "); Serial.print(raw_readings[idx]); Serial.print(" "); Serial.print(diff); Serial.print(" "); Serial.print(channel_offsets[idx]); Serial.print(" "); Serial.println(raw);
    }

    for (int i = 0; i < R5_SIZE; i++) {
      uint8_t idx = r5_pins[i];

      if (raw_readings[idx] < R5_OFFSET_THRESHOLD) {
        if (channel_offsets[idx] == 0) {
          channel_offsets[idx] = raw_readings[idx];
        } else if (abs((int)raw_readings[idx] - channel_offsets[idx]) < OFFSET_DIFF_THRESHOLD) {
          // Update offset if the new reading is close to the current offset
          channel_offsets[idx] = (channel_offsets[idx] + raw_readings[idx]) / 2;
        }
      }

      uint16_t raw = raw_readings[idx];
      uint16_t total_offset = DEFAULT_OFFSET + channel_offsets[idx];
      if (raw < total_offset) {
        raw = 0;
      } else {
        raw -= total_offset;
      }

      currPkt.readings[idx] = raw;
    }

    currPkt.chksum = additive_chksum(currPkt.readings, counter);
    currPkt.header = header;
    prevTime_us = now_us;

    if (counter == 65535) {  // Needs to restart from 1
      counter = 1;
    } else {
      counter += 1;
    }

    packet_position += 1;
  }

  // Write to ESP Now
  esp_err_t transmission_result = esp_now_send(boadcastAddr, (uint8_t *)&bulkPacket, sizeof(bulkPacket));

  if (transmission_result != ESP_OK) {
    taskYIELD();
    transmission_result = esp_now_send(boadcastAddr, (uint8_t *)&bulkPacket, sizeof(bulkPacket));
  }

  /*
  if (transmission_result != ESP_OK) {
    Serial.println("Failed to queue");
  }
  */

#if SHOW_SUCCESS
  if (transmission_result == ESP_OK) {
    Serial.println("Successfully queued for sending");
  }
#endif

  packet_position = 0;  // Manually reset to 0 index
  taskYIELD();
}
